import { query } from "@anthropic-ai/claude-agent-sdk";
import { run } from "./exec.ts";
import { collectTests, runPytest, type TestResult } from "./pytest.ts";

export type FixRequest = {
  cwd: string;
  /** The package whose major version moved, e.g. "pydantic". */
  library: string;
  fromVersion?: string;
  toVersion?: string;
  /** Interpreter with the project's dependencies already installed. */
  python?: string;
  /** Hard ceiling. The run is abandoned rather than allowed to exceed it. */
  maxBudgetUsd: number;
  maxTurns: number;
  /** Extra pytest args, e.g. eval sandboxes blank warning filters. */
  pytestArgs?: string[];
  /** Explicit Claude Code binary. Required when running from a bundle with no
   *  node_modules (the SDK cannot resolve its platform package there). */
  pathToClaudeCodeExecutable?: string;
};

export type FixOutcome = {
  fixed: boolean;
  /** Why we shipped or, far more often, why we stayed quiet. */
  reason: string;
  costUsd: number;
  turns: number;
  before: TestResult;
  after?: TestResult;
  filesChanged: string[];
};

const TEST_PATH = /(^|\/)(tests?|testing)\//i;
// pytest.ini and tox.ini count as test files: editing them can deselect or
// weaken tests without touching a test module.
const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py|pytest\.ini|tox\.ini)$/i;

const isTestFile = (p: string) => TEST_PATH.test(p) || TEST_FILE.test(p);

/**
 * Build output the agent's own test runs leave behind. Repos without a
 * .gitignore surface these in `git diff`, and committing bytecode into a
 * customer's PR is an instant credibility loss.
 */
const ARTIFACT =
  /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|node_modules|\.venv|venv|[^/]*\.egg-info)\/|\.py[co]$|(^|\/)\.DS_Store$/i;

/**
 * Everything currently dirty, including untracked files. `git diff` alone
 * reports only tracked edits, so a new module would be dropped from the commit
 * and the pushed branch would not build. quotepath=off so non-ASCII paths come
 * back literal instead of octal-escaped (which `git add` cannot match).
 */
async function dirtyPaths(cwd: string): Promise<string[]> {
  const r = await run(
    "git",
    ["-c", "core.quotepath=off", "status", "--porcelain", "--untracked-files=all"],
    { cwd, timeoutMs: 30_000 },
  );
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3).trim();
      // Renames appear as "R  old -> new"; the new path is what we commit.
      const arrow = path.indexOf(" -> ");
      return arrow === -1 ? path : path.slice(arrow + 4);
    })
    .map((p) => p.replace(/^"|"$/g, ""))
    .filter(Boolean)
    .filter((p) => !ARTIFACT.test(p));
}

function buildPrompt(req: FixRequest, failures: string): string {
  const version =
    req.fromVersion && req.toVersion
      ? `${req.library} ${req.fromVersion} → ${req.toVersion}`
      : `${req.library} (major version upgrade)`;

  return `A dependency upgrade broke this repository's test suite.

UPGRADE: ${version}

The dependency version has already been changed. The source code has not been
updated to match the new API, so the tests now fail:

<test-failures>
${failures}
</test-failures>

Your job is to update the SOURCE CODE so the existing tests pass against the new
version of ${req.library}.

How to work:
1. Read the failing output and find the code that uses the old API.
2. If you are unsure what replaced an API, fetch the library's official migration
   guide or changelog and read what actually changed. Do not guess at renames.
3. Make the change, then run the test suite yourself to check:
   ${req.python ?? "python"} -m pytest -q
4. Repeat until the suite is green.

Hard rules — a violation makes the whole attempt worthless:
- NEVER edit, delete, skip, or weaken a test. Not in tests/, not conftest.py, not
  anywhere. The tests define correctness; changing them to get green is cheating
  and the result is discarded.
- Do not add xfail, skip markers, or try/except around failing assertions.
- Do not change the dependency version back, and do not pin around the problem.
- Only fix breakage caused by this upgrade. Leave unrelated code alone.
- Watch for silent semantic changes, not just renamed symbols. Some APIs keep
  their name but behave differently, and a passing test does not prove those are
  right. If you find one, fix it and say so.

If you genuinely cannot make the suite pass, stop and say so plainly. Stopping is
a valid, useful outcome — shipping a wrong patch is not.`;
}

/**
 * Try to make a broken suite pass after a major-version bump.
 *
 * The contract is deliberately conservative: we only report success when the
 * suite is actually green AND the agent left the tests alone. Anything else
 * returns fixed:false, which upstream treats as "stay silent" — a failed attempt
 * costs tokens and is never shown to a customer.
 */
export async function attemptFix(req: FixRequest): Promise<FixOutcome> {
  const testOpts = { cwd: req.cwd, python: req.python, args: req.pytestArgs };

  const before = await runPytest(testOpts);
  const base: Omit<FixOutcome, "fixed" | "reason"> = {
    costUsd: 0,
    turns: 0,
    before,
    filesChanged: [],
  };

  if (!before.ran) return { ...base, fixed: false, reason: "no tests collected — nothing to verify against" };
  if (before.passed) return { ...base, fixed: false, reason: "suite already green — no upgrade breakage to fix" };

  const collectedBefore = await collectTests(testOpts);

  // Anything already dirty (install steps, generated files) is not the
  // agent's work: committing it could push unrelated — even sensitive —
  // workspace content onto the customer's PR.
  const preDirty = new Set(await dirtyPaths(req.cwd));

  // The agent gets Bash, so it must not inherit credentials: a push-capable
  // token in its env would let a confused agent deliver an unverified fix
  // itself, around every gate below.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k !== "GITHUB_TOKEN" && k !== "GH_TOKEN" && !k.startsWith("INPUT_"),
    ),
  ) as Record<string, string>;

  let costUsd = 0;
  let turns = 0;
  let finalText = "";

  const conversation = query({
    prompt: buildPrompt(req, before.output),
    options: {
      cwd: req.cwd,
      env,
      model: "claude-opus-5",
      permissionMode: "bypassPermissions",
      maxTurns: req.maxTurns,
      maxBudgetUsd: req.maxBudgetUsd,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch"],
      settingSources: [],
      ...(req.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: req.pathToClaudeCodeExecutable }
        : {}),
    },
  });

  try {
    for await (const message of conversation) {
      if (message.type === "result") {
        costUsd = message.total_cost_usd ?? 0;
        turns = message.num_turns ?? 0;
        if (message.subtype === "success") finalText = message.result ?? "";
      }
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // The SDK throws when a run is cut off (budget ceiling, transport error)
    // instead of yielding a result message, and the true spend is unknowable
    // then. Report the worst case: under-reporting would let the action's
    // shared-budget loop hand the next attempt money that is already gone.
    const capped = /maximum budget/i.test(msg);
    return {
      ...base,
      costUsd: req.maxBudgetUsd,
      turns,
      fixed: false,
      reason: capped
        ? `budget exhausted ($${req.maxBudgetUsd}) before the suite went green`
        : `agent run failed (spend unknown, assuming full budget): ${msg.slice(0, 200)}`,
    };
  }

  const filesChanged = (await dirtyPaths(req.cwd)).filter((p) => !preDirty.has(p));
  const withCost = { ...base, costUsd, turns, filesChanged };

  if (!filesChanged.length) {
    return { ...withCost, fixed: false, reason: `agent made no changes${finalText ? `: ${finalText.slice(0, 200)}` : ""}` };
  }

  const touchedTests = filesChanged.filter(isTestFile);
  if (touchedTests.length) {
    return { ...withCost, fixed: false, reason: `rejected — agent modified tests: ${touchedTests.join(", ")}` };
  }

  const after = await runPytest(testOpts);
  if (!after.passed) {
    return { ...withCost, after, fixed: false, reason: `suite still red (${after.counts.failed} failed, ${after.counts.errors} errors)` };
  }

  // Set comparison, not count: an agent could deselect tests via config edits
  // (`-k`, `--ignore`, addopts) without changing any file the guard above sees.
  const collectedAfter = await collectTests(testOpts);
  const missing = [...collectedBefore.ids].filter((id) => !collectedAfter.ids.has(id));
  const shrunk = collectedBefore.ids.size
    ? missing.length > 0
    : collectedAfter.count < collectedBefore.count;
  if (shrunk) {
    return {
      ...withCost,
      after,
      fixed: false,
      reason: missing.length
        ? `rejected — tests no longer collected: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}`
        : `rejected — collected tests dropped ${collectedBefore.count} → ${collectedAfter.count}`,
    };
  }

  // A "fix" that downgrades the library back to the old major would pass every
  // gate above; the prompt forbids it, but verify rather than trust.
  const reverted = await upgradeReverted(req);
  if (reverted) {
    return { ...withCost, after, fixed: false, reason: `rejected — ${reverted}` };
  }

  return {
    ...withCost,
    after,
    fixed: true,
    reason: `${after.counts.passed} passed, ${collectedAfter.count} collected, ${filesChanged.length} file(s) changed`,
  };
}

/** Best-effort check that the target library still sits at the new major. */
async function upgradeReverted(req: FixRequest): Promise<string | null> {
  const wantMajor = Number(req.toVersion?.match(/^v?(\d+)/)?.[1] ?? NaN);
  const fromMajor = Number(req.fromVersion?.match(/^v?(\d+)/)?.[1] ?? NaN);
  if (!Number.isFinite(wantMajor) && !Number.isFinite(fromMajor)) return null;

  const r = await run(
    req.python ?? "python",
    ["-c", `import importlib.metadata as m; print(m.version(${JSON.stringify(req.library)}))`],
    { cwd: req.cwd, timeoutMs: 30_000 },
  );
  const installed = r.stdout.trim();
  const major = Number(installed.match(/^v?(\d+)/)?.[1] ?? NaN);
  if (!r.ok || !Number.isFinite(major)) return null;

  const tooOld = Number.isFinite(wantMajor) ? major < wantMajor : major <= fromMajor;
  return tooOld ? `${req.library} is at ${installed} — the upgrade was reverted, not fixed` : null;
}
