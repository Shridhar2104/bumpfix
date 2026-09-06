import { query } from "@anthropic-ai/claude-agent-sdk";
import { run } from "./exec.ts";
import { collectCount, runPytest, type TestResult } from "./pytest.ts";

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
const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/i;

const isTestFile = (p: string) => TEST_PATH.test(p) || TEST_FILE.test(p);

/**
 * Build output the agent's own test runs leave behind. Repos without a
 * .gitignore surface these in `git diff`, and committing bytecode into a
 * customer's PR is an instant credibility loss.
 */
const ARTIFACT =
  /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|node_modules|\.venv|venv|[^/]*\.egg-info)\/|\.py[co]$|(^|\/)\.DS_Store$/i;

/**
 * Everything the agent touched, including files it created. `git diff` alone
 * reports only tracked edits, so a new module would be dropped from the commit
 * and the pushed branch would not build.
 */
async function changedFiles(cwd: string): Promise<string[]> {
  const r = await run("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    timeoutMs: 30_000,
  });
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

  const countBefore = await collectCount(testOpts);

  let costUsd = 0;
  let turns = 0;
  let finalText = "";

  const conversation = query({
    prompt: buildPrompt(req, before.output),
    options: {
      cwd: req.cwd,
      model: "claude-opus-5",
      permissionMode: "bypassPermissions",
      maxTurns: req.maxTurns,
      maxBudgetUsd: req.maxBudgetUsd,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch"],
      settingSources: [],
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
    // The SDK throws when the run is cut off at the budget ceiling instead of
    // yielding a result message. A capped run is a normal outcome here, and it
    // must report its spend — otherwise the action's shared-budget loop would
    // hand the next attempt money that is already gone.
    const capped = /maximum budget/i.test(msg);
    return {
      ...base,
      costUsd: capped ? req.maxBudgetUsd : costUsd,
      turns,
      fixed: false,
      reason: capped
        ? `budget exhausted ($${req.maxBudgetUsd}) before the suite went green`
        : `agent run failed: ${msg.slice(0, 200)}`,
    };
  }

  const filesChanged = await changedFiles(req.cwd);
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

  const countAfter = await collectCount(testOpts);
  if (countAfter < countBefore) {
    return {
      ...withCost,
      after,
      fixed: false,
      reason: `rejected — collected tests dropped ${countBefore} → ${countAfter}`,
    };
  }

  return {
    ...withCost,
    after,
    fixed: true,
    reason: `${after.counts.passed} passed, ${countAfter} collected, ${filesChanged.length} file(s) changed`,
  };
}
