import { appendFile } from "node:fs/promises";
import { attemptFix } from "../core/agent.ts";
import { detectMajorBumps, type DetectedBump } from "../core/detect.ts";
import { run } from "../core/exec.ts";
import {
  renderSummary,
  totalCost,
  writeOutcomeFile,
  type AttemptOutcome,
  type DeliveryOutcome,
  type OutcomeRecord,
} from "../core/outcome.ts";
import { buildCommentBody, postComment } from "./comment.ts";
import { loadPrContext } from "./context.ts";
import { choosePushTarget, commitFix, push, remoteHead } from "./deliver.ts";

/**
 * GitHub Action entry point.
 *
 * Runs inside the customer's own CI, where their dependencies are already
 * installed — which is the whole reason this shape was chosen. We never clone
 * their code to our infrastructure and never hold a credential of theirs.
 *
 * It must never fail their build. Every path exits 0.
 */

const input = (name: string, fallback = "") =>
  process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`]?.trim() || fallback;

async function summary(md: string) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    try {
      await appendFile(path, md + "\n");
    } catch (err) {
      console.warn(`greenbump: step summary: ${(err as Error).message}`);
    }
  }
  console.log(md.replace(/[#*`]/g, ""));
}

const cwd = input("working-directory", process.env.GITHUB_WORKSPACE || process.cwd());
const python = input("python", "python");

// Malformed numeric inputs must not silently defeat the budget cap.
const parsedBudget = Number(input("max-cost-usd", "3"));
const maxBudgetUsd = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 3;
const parsedTurns = Number(input("max-turns", "40"));
const maxTurns =
  Number.isInteger(parsedTurns) && parsedTurns > 0 ? parsedTurns : 40;

const token = process.env.GITHUB_TOKEN || input("github-token");
const repo = process.env.GITHUB_REPOSITORY;

const git = (args: string[]) => run("git", args, { cwd, timeoutMs: 120_000 });

const startedAt = new Date().toISOString();
const pr = await loadPrContext();

const MANIFEST_PATHSPECS = [
  "requirements*.txt", "**/requirements*.txt",
  "pyproject.toml", "**/pyproject.toml",
  "poetry.lock", "**/poetry.lock",
  "uv.lock", "**/uv.lock",
  "Pipfile", "Pipfile.lock", "**/Pipfile", "**/Pipfile.lock",
  "setup.py", "setup.cfg",
];

async function detectBumps(): Promise<DetectedBump[]> {
  const override = input("library");
  if (override) {
    return [
      {
        library: override,
        fromVersion: input("from-version") || undefined,
        toVersion: input("to-version") || undefined,
        manifest: "(library input)",
      },
    ];
  }
  if (!pr) return [];
  await git(["fetch", "--quiet", "--depth=1", "origin", pr.baseSha]);
  const diff = await git(["diff", pr.baseSha, "HEAD", "--", ...MANIFEST_PATHSPECS]);
  return detectMajorBumps(diff.stdout);
}

const buildRecord = (
  attempts: AttemptOutcome[],
  detected: DetectedBump[],
  delivery: DeliveryOutcome,
): OutcomeRecord => ({
  schema: 1,
  repo,
  pr: pr?.prNumber,
  startedAt,
  finishedAt: new Date().toISOString(),
  detected,
  attempts,
  delivery,
  totalCostUsd: totalCost(attempts),
});

async function finish(record: OutcomeRecord): Promise<never> {
  await writeOutcomeFile(record).catch((err) => console.warn(`greenbump: outcome file: ${err.message}`));
  await summary(renderSummary(record));
  process.exit(0);
}

const NONE: DeliveryOutcome = { mode: "none", pushed: false, commented: false };

let detected: DetectedBump[] = [];
try {
  detected = await detectBumps();
} catch (err) {
  console.warn(`greenbump: detection failed: ${(err as Error).message}`);
}

if (!detected.length) {
  console.log("greenbump: no major-version bumps detected");
  await finish(buildRecord([], [], NONE));
}

const checkoutSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

/** Untracked files present before we ran, so cleanup can spare them. */
async function untracked(): Promise<Set<string>> {
  const r = await git(["ls-files", "--others", "--exclude-standard"]);
  return new Set(r.stdout.split("\n").filter(Boolean));
}
const baselineUntracked = await untracked();

/** Drop everything a failed attempt left behind before the next one starts. */
async function revertWorkingTree() {
  await git(["checkout", "--", "."]);
  const created = [...(await untracked())].filter((f) => !baselineUntracked.has(f));
  if (created.length) await git(["clean", "-fq", "--", ...created]);
}

const attempts: AttemptOutcome[] = [];
const fixedLibraries: string[] = [];

for (const bump of detected) {
  const spent = totalCost(attempts);
  const remaining = Math.round((maxBudgetUsd - spent) * 100) / 100;
  const base = { library: bump.library, fromVersion: bump.fromVersion, toVersion: bump.toVersion };

  if (remaining < 0.25) {
    attempts.push({
      ...base,
      fixed: false,
      reason: `skipped — $${spent.toFixed(2)} of the $${maxBudgetUsd} budget already spent`,
      costUsd: 0,
      turns: 0,
      filesChanged: [],
      durationMs: 0,
    });
    continue;
  }

  console.log(`greenbump · ${bump.library} · budget $${remaining} · max ${maxTurns} turns`);
  const started = Date.now();
  let committed = false;
  try {
    const out = await attemptFix({
      cwd,
      library: bump.library,
      fromVersion: bump.fromVersion,
      toVersion: bump.toVersion,
      python,
      maxBudgetUsd: remaining,
      maxTurns,
    });
    attempts.push({
      ...base,
      fixed: out.fixed,
      reason: out.reason,
      costUsd: out.costUsd,
      turns: out.turns,
      testsBefore: out.before.counts,
      testsAfter: out.after?.counts,
      filesChanged: out.filesChanged,
      durationMs: Date.now() - started,
    });

    if (out.fixed) {
      // Commit each verified fix immediately so a later failed attempt's
      // cleanup cannot touch it.
      committed = await commitFix(
        cwd,
        out.filesChanged,
        `greenbump: migrate to ${bump.library} ${bump.toVersion ?? "major upgrade"}\n\n` +
          `${out.reason}\n\nVerified: the existing test suite passes and no test files were modified.`,
      );
      if (committed) {
        fixedLibraries.push(bump.library);
      } else {
        attempts[attempts.length - 1] = {
          ...attempts[attempts.length - 1],
          fixed: false,
          reason: "fix verified but git commit failed",
        };
      }
    }
  } catch (err) {
    attempts.push({
      ...base,
      fixed: false,
      reason: `attempt errored: ${(err as Error).message}`,
      costUsd: 0,
      turns: 0,
      filesChanged: [],
      durationMs: Date.now() - started,
    });
  }
  if (!committed) await revertWorkingTree();
}

if (!fixedLibraries.length) {
  await finish(buildRecord(attempts, detected, NONE));
}

const fallbackBranch = input(
  "branch",
  `greenbump/${fixedLibraries.join("-")}-${Date.now().toString(36)}`,
);

if (!token || !repo) {
  await git(["branch", fallbackBranch]);
  await finish(
    buildRecord(attempts, detected, {
      mode: "local",
      branch: fallbackBranch,
      pushed: false,
      commented: false,
      note: "no token available",
    }),
  );
}

const url = `https://x-access-token:${token}@github.com/${repo}.git`;
const plan = choosePushTarget({
  pr,
  checkoutSha,
  remoteHeadSha: pr ? await remoteHead(cwd, url, pr.headRef) : null,
  fallbackBranch,
});

const pushed = await push(cwd, url, plan.branch);
let delivery: DeliveryOutcome;

if (pushed.ok) {
  delivery = { mode: plan.mode, branch: plan.branch, pushed: true, commented: false, note: plan.note };
} else if (plan.mode === "pr-branch") {
  // The PR branch can move between our ls-remote check and this push (someone
  // else pushed in between), rejecting it as a non-fast-forward. Retry once
  // against the fallback branch rather than losing an already-verified fix.
  const retry = await push(cwd, url, fallbackBranch);
  delivery = retry.ok
    ? {
        mode: "fix-branch",
        branch: fallbackBranch,
        pushed: true,
        commented: false,
        note: "the PR branch moved while greenbump was pushing the fix",
      }
    : { mode: plan.mode, branch: plan.branch, pushed: false, commented: false, note: `push failed: ${pushed.stderr.slice(-300)}` };
} else {
  delivery = {
    mode: plan.mode,
    branch: plan.branch,
    pushed: false,
    commented: false,
    note: `push failed: ${pushed.stderr.slice(-300)}`,
  };
}

if (delivery.pushed && pr && token) {
  const body = buildCommentBody(buildRecord(attempts, detected, delivery));
  if (body) delivery.commented = await postComment(token, pr.repo, pr.prNumber, body);
}

await finish(buildRecord(attempts, detected, delivery));
