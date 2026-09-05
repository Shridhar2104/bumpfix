import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, tail } from "../core/exec.ts";

const CLONE_MS = 180_000;
const INSTALL_MS = 480_000;
const TEST_MS = 300_000;

/**
 * Python to build the venv with. Repos in the pydantic-v1 era predate 3.13 and
 * frequently fail to build against it, so we pin lower unless the project says
 * otherwise. uv downloads the interpreter on demand.
 */
const DEFAULT_PYTHON = "3.11";

export type TestResult = {
  ran: boolean;
  passed: boolean;
  counts: { passed: number; failed: number; errors: number; skipped: number };
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  output: string;
};

export type CaseProbe = {
  stage: "clone" | "detect" | "install" | "test" | "done";
  ok: boolean;
  reason?: string;
  python?: string;
  installer?: string;
  test?: TestResult;
  ms: number;
};

/** Shallow-fetch exactly one commit. Far cheaper than cloning history. */
export async function checkout(repo: string, sha: string, dir: string) {
  const url = `https://github.com/${repo}.git`;
  let r = await run("git", ["init", "-q", "--initial-branch=main", dir], { timeoutMs: 30_000 });
  if (!r.ok) return { ok: false, reason: `git init: ${tail(r.stderr, 3)}` };

  r = await run("git", ["remote", "add", "origin", url], { cwd: dir, timeoutMs: 30_000 });
  if (!r.ok) return { ok: false, reason: `git remote: ${tail(r.stderr, 3)}` };

  r = await run("git", ["fetch", "--depth", "1", "--quiet", "origin", sha], {
    cwd: dir,
    timeoutMs: CLONE_MS,
  });
  if (!r.ok) return { ok: false, reason: `fetch ${sha.slice(0, 8)}: ${tail(r.stderr, 3) || "unavailable"}` };

  r = await run("git", ["checkout", "--quiet", "FETCH_HEAD"], { cwd: dir, timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, reason: `checkout: ${tail(r.stderr, 3)}` };

  return { ok: true as const };
}

/** Lowest Python the project claims to support, so the venv matches its era. */
async function detectPython(dir: string): Promise<string> {
  const pin = join(dir, ".python-version");
  if (existsSync(pin)) {
    const v = (await readFile(pin, "utf8")).trim().match(/^(\d+\.\d+)/);
    if (v) return v[1];
  }
  for (const f of ["pyproject.toml", "setup.py", "setup.cfg"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const text = await readFile(p, "utf8");
    const m = text.match(/requires[-_]python\s*[=:]\s*["']([^"']+)["']/i);
    if (m) {
      const lower = m[1].match(/>=?\s*(\d+\.\d+)/);
      if (lower) {
        const [maj, min] = lower[1].split(".").map(Number);
        // Cap it: a floor of >=3.8 shouldn't put us on 3.8, and >=3.13 is fine.
        if (maj === 3 && min >= 9 && min <= 13) return lower[1];
      }
    }
  }
  return DEFAULT_PYTHON;
}

type Installer = { label: string; steps: string[][] };

/**
 * Group names that conventionally carry test dependencies, best first.
 * Projects almost never put pytest in runtime deps, so installing only the
 * runtime set leaves every suite erroring on import — which is exactly how a
 * healthy repo gets mis-recorded as "red at parent".
 */
const TEST_GROUPS = ["test", "tests", "dev", "testing", "develop", "all", "standard"];

/**
 * Poetry declares groups as `[tool.poetry.group.<name>.dependencies]`, which is
 * neither a PEP 621 extra nor a PEP 735 group, so uv cannot install it from the
 * manifest. Pull the package names out and install them unpinned — we need
 * pytest and its plugins present, not the project's exact resolution.
 */
function poetryGroupDeps(text: string): string[] {
  for (const group of TEST_GROUPS) {
    const keys = tableKeys(text, `tool\\.poetry\\.group\\.${group}\\.dependencies`);
    if (keys.length) return keys.filter((k) => k !== "python");
  }
  return [];
}

/**
 * Keys of a TOML table, read without a TOML parser.
 *
 * The leading whitespace class is `[ \t]*`, not `\s*`: `\s` matches newlines,
 * so with the `m` flag the match would start on a preceding blank line and the
 * header would survive the slice below, silently yielding no keys.
 */
export function tableKeys(text: string, header: string): string[] {
  const start = text.search(new RegExp(`^[ \\t]*\\[${header}\\]`, "m"));
  if (start === -1) return [];
  const rest = text.slice(start).split("\n").slice(1);
  const keys: string[] = [];
  for (const line of rest) {
    if (/^[ \t]*\[/.test(line)) break;
    const m = line.match(/^[ \t]*["']?([A-Za-z][\w.-]*)["']?[ \t]*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

const pickGroup = (groups: string[]) =>
  TEST_GROUPS.find((g) => groups.includes(g)) ?? null;

/** How this project declares dependencies, including its test extras. */
async function detectInstaller(dir: string): Promise<Installer | null> {
  const has = (f: string) => existsSync(join(dir, f));
  const steps: string[][] = [];
  const labels: string[] = [];

  const mainReqs = ["requirements.txt", "requirements/base.txt", "requirements/main.txt"].filter(has);
  const testReqs = [
    "requirements-dev.txt", "requirements-test.txt", "requirements-tests.txt",
    "requirements/dev.txt", "requirements/test.txt", "requirements/tests.txt",
    "test-requirements.txt", "dev-requirements.txt",
  ].filter(has);

  if (has("pyproject.toml")) {
    const text = await readFile(join(dir, "pyproject.toml"), "utf8");
    const isPep621 = /^\s*\[project\]/m.test(text);
    const isPoetry = /^\s*\[tool\.poetry\]/m.test(text);

    if (isPep621 || isPoetry) {
      const extra = pickGroup(tableKeys(text, "project\\.optional-dependencies"));
      steps.push(["pip", "install", extra ? `.[${extra}]` : "."]);
      labels.push(extra ? `pyproject[${extra}]` : "pyproject");

      // PEP 735 dependency groups are separate from extras and often hold pytest.
      const group = pickGroup(tableKeys(text, "dependency-groups"));
      if (group) {
        steps.push(["pip", "install", "--group", group]);
        labels.push(`group:${group}`);
      }

      const poetryDeps = poetryGroupDeps(text);
      if (poetryDeps.length) {
        steps.push(["pip", "install", ...poetryDeps]);
        labels.push(`poetry-group(${poetryDeps.length})`);
      }
    }
  }

  if (!steps.length && mainReqs.length) {
    steps.push(["pip", "install", "-r", mainReqs[0]]);
    labels.push(mainReqs[0]);
  }
  if (!steps.length && (has("setup.py") || has("setup.cfg"))) {
    steps.push(["pip", "install", "."]);
    labels.push("setup.py");
  }
  if (!steps.length) return null;

  for (const f of testReqs.slice(0, 2)) {
    steps.push(["pip", "install", "-r", f]);
    labels.push(f);
  }

  return { label: labels.join(" + "), steps };
}

/** Does this repo contain anything pytest could collect? */
async function hasTests(dir: string): Promise<boolean> {
  const skip = new Set([".git", ".venv", "node_modules", "__pycache__", "build", "dist", ".tox"]);
  const walk = async (d: string, depth: number): Promise<boolean> => {
    if (depth > 3) return false;
    let items;
    try {
      items = await readdir(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const it of items) {
      if (skip.has(it.name)) continue;
      if (it.isFile() && /^test_.*\.py$|_test\.py$/.test(it.name)) return true;
      if (it.isDirectory() && (await walk(join(d, it.name), depth + 1))) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

function parsePytest(out: string): TestResult["counts"] {
  const counts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  // pytest's summary line, e.g. "3 failed, 12 passed, 1 skipped in 4.21s"
  const line = out.split("\n").reverse().find((l) => /\d+ (passed|failed|error|skipped)/.test(l)) ?? "";
  for (const [, n, word] of line.matchAll(/(\d+) (passed|failed|errors?|skipped)/g)) {
    const k = word.startsWith("error") ? "errors" : (word as keyof typeof counts);
    counts[k] = Number(n);
  }
  return counts;
}

async function runTests(dir: string, venv: string): Promise<TestResult> {
  const py = join(venv, "bin", "python");
  const r = await run(
    py,
    [
      "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider", "--maxfail=20",
      // Many projects set filterwarnings=error. We check out a 2024 commit but
      // install today's transitive deps, which emit warnings that did not exist
      // then — so collection dies before a test runs. We are measuring whether
      // the code works, not whether a repo's warning policy survives newer
      // dependencies, so blank the filters for probing.
      "--override-ini=filterwarnings=",
    ],
    { cwd: dir, timeoutMs: TEST_MS, env: { PYTHONDONTWRITEBYTECODE: "1", CI: "1" } },
  );
  const out = r.stdout + "\n" + r.stderr;
  const counts = parsePytest(out);
  return {
    // exit 5 means pytest collected nothing — not a real run
    ran: r.code !== 5 && !r.timedOut,
    passed: r.code === 0,
    counts,
    exitCode: r.code,
    timedOut: r.timedOut,
    ms: r.ms,
    output: tail(out, 30),
  };
}

export type PreparedCase = {
  dir: string;
  /** venv interpreter path — hand this to pytest or the fix agent. */
  python: string;
  pythonVersion: string;
  installer: string;
};

/** Environment that points uv at the case's venv. */
export const venvEnv = (dir: string) => ({
  VIRTUAL_ENV: join(dir, ".venv"),
  UV_PROJECT_ENVIRONMENT: join(dir, ".venv"),
});

/**
 * Clone one commit and build its environment, keeping the workspace alive.
 * The caller owns `dir` on success and must delete it; failures clean up
 * after themselves.
 */
export async function prepareCase(
  repo: string,
  sha: string,
): Promise<{ ok: true; prepared: PreparedCase } | { ok: false; stage: CaseProbe["stage"]; reason: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bcm-"));
  const fail = async (stage: CaseProbe["stage"], reason: string) => {
    await rm(dir, { recursive: true, force: true });
    return { ok: false as const, stage, reason };
  };

  const co = await checkout(repo, sha, dir);
  if (!co.ok) return fail("clone", co.reason ?? "clone failed");
  if (!(await hasTests(dir))) return fail("detect", "no test files");

  const python = await detectPython(dir);
  const installer = await detectInstaller(dir);
  if (!installer) return fail("detect", "no dependency manifest");

  const venv = join(dir, ".venv");
  let r = await run("uv", ["venv", "--python", python, venv], { cwd: dir, timeoutMs: 180_000 });
  if (!r.ok) return fail("install", `venv ${python}: ${tail(r.stderr, 2)}`);

  for (const [i, args] of installer.steps.entries()) {
    r = await run("uv", args, { cwd: dir, timeoutMs: INSTALL_MS, env: venvEnv(dir) });
    // Only the first step is load-bearing; extras groups are best-effort.
    if (!r.ok && i === 0) return fail("install", r.timedOut ? "install timed out" : tail(r.stderr, 3));
  }

  // pytest itself is often only a dev-extra; install it explicitly.
  await run("uv", ["pip", "install", "pytest", "pytest-asyncio", "anyio"], {
    cwd: dir,
    timeoutMs: 180_000,
    env: venvEnv(dir),
  });

  return {
    ok: true,
    prepared: { dir, python: join(venv, "bin", "python"), pythonVersion: python, installer: installer.label },
  };
}

/**
 * Clone one commit, build an isolated environment, run the suite, then delete
 * everything. Disk is the scarce resource here, so the workspace never outlives
 * the probe.
 */
export async function probeCase(repo: string, sha: string): Promise<CaseProbe> {
  const started = Date.now();
  const prep = await prepareCase(repo, sha);
  if (!prep.ok) {
    return { stage: prep.stage, ok: false, reason: prep.reason, ms: Date.now() - started };
  }
  const { dir, pythonVersion, installer } = prep.prepared;
  try {
    const test = await runTests(dir, join(dir, ".venv"));
    return {
      stage: test.ran ? "done" : "test",
      ok: test.ran && test.passed,
      reason: test.ran ? (test.passed ? undefined : "suite red at parent") : "collected no tests",
      python: pythonVersion,
      installer,
      test,
      ms: Date.now() - started,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Drop cached wheels that nothing currently references. */
export async function pruneCache() {
  await run("uv", ["cache", "prune"], { timeoutMs: 180_000 });
}

/** Free bytes on the volume holding the workspace root. */
export async function freeDiskGB(): Promise<number> {
  const r = await run("df", ["-k", tmpdir()], { timeoutMs: 10_000 });
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  const avail = Number(line.split(/\s+/)[3]);
  return Number.isFinite(avail) ? avail / 1024 / 1024 : 0;
}
