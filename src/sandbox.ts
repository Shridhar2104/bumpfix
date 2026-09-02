import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, tail } from "./exec.ts";

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

type Installer = { label: string; args: string[] };

/** How this project declares dependencies, in order of preference. */
async function detectInstaller(dir: string): Promise<Installer | null> {
  const has = (f: string) => existsSync(join(dir, f));

  const reqNames = ["requirements.txt", "requirements/base.txt", "requirements/dev.txt", "requirements-dev.txt"];
  const reqs = reqNames.filter(has);

  if (has("pyproject.toml")) {
    const text = await readFile(join(dir, "pyproject.toml"), "utf8");
    const isPep621 = /^\s*\[project\]/m.test(text);
    const isPoetry = /^\s*\[tool\.poetry\]/m.test(text);
    if (isPep621) return { label: "pyproject", args: ["pip", "install", "."] };
    if (isPoetry && !reqs.length) return { label: "poetry", args: ["pip", "install", "."] };
  }
  if (reqs.length) return { label: reqs[0], args: ["pip", "install", "-r", reqs[0]] };
  if (has("setup.py") || has("setup.cfg")) return { label: "setup.py", args: ["pip", "install", "."] };
  return null;
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
    ["-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider", "-x", "--maxfail", "20"],
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

/**
 * Clone one commit, build an isolated environment, run the suite, then delete
 * everything. Disk is the scarce resource here, so the workspace never outlives
 * the probe.
 */
export async function probeCase(repo: string, sha: string): Promise<CaseProbe> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "bcm-"));
  const done = (p: Omit<CaseProbe, "ms">): CaseProbe => ({ ...p, ms: Date.now() - started });

  try {
    const co = await checkout(repo, sha, dir);
    if (!co.ok) return done({ stage: "clone", ok: false, reason: co.reason });

    if (!(await hasTests(dir))) {
      return done({ stage: "detect", ok: false, reason: "no test files" });
    }

    const python = await detectPython(dir);
    const installer = await detectInstaller(dir);
    if (!installer) return done({ stage: "detect", ok: false, reason: "no dependency manifest", python });

    const venv = join(dir, ".venv");
    let r = await run("uv", ["venv", "--python", python, venv], { cwd: dir, timeoutMs: 180_000 });
    if (!r.ok) {
      return done({ stage: "install", ok: false, reason: `venv ${python}: ${tail(r.stderr, 2)}`, python, installer: installer.label });
    }

    r = await run("uv", installer.args, {
      cwd: dir,
      timeoutMs: INSTALL_MS,
      env: { VIRTUAL_ENV: venv, UV_PROJECT_ENVIRONMENT: venv },
    });
    if (!r.ok) {
      return done({
        stage: "install",
        ok: false,
        reason: r.timedOut ? "install timed out" : tail(r.stderr, 3),
        python,
        installer: installer.label,
      });
    }

    // pytest itself is often only a dev-extra; install it explicitly.
    await run("uv", ["pip", "install", "pytest"], {
      cwd: dir,
      timeoutMs: 180_000,
      env: { VIRTUAL_ENV: venv, UV_PROJECT_ENVIRONMENT: venv },
    });

    const test = await runTests(dir, venv);
    return done({
      stage: test.ran ? "done" : "test",
      ok: test.ran && test.passed,
      reason: test.ran ? (test.passed ? undefined : "suite red at parent") : "collected no tests",
      python,
      installer: installer.label,
      test,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Free bytes on the volume holding the workspace root. */
export async function freeDiskGB(): Promise<number> {
  const r = await run("df", ["-k", tmpdir()], { timeoutMs: 10_000 });
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  const avail = Number(line.split(/\s+/)[3]);
  return Number.isFinite(avail) ? avail / 1024 / 1024 : 0;
}
