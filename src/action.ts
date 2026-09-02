import { appendFile } from "node:fs/promises";
import { attemptFix } from "./agent.ts";
import { run } from "./exec.ts";

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
  if (path) await appendFile(path, md + "\n");
  console.log(md.replace(/[#*`]/g, ""));
}

const library = input("library");
if (!library) {
  console.error("greenbump: `library` input is required (e.g. pydantic)");
  process.exit(0);
}

const req = {
  cwd: input("working-directory", process.env.GITHUB_WORKSPACE || process.cwd()),
  library,
  fromVersion: input("from-version") || undefined,
  toVersion: input("to-version") || undefined,
  python: input("python", "python"),
  maxBudgetUsd: Number(input("max-cost-usd", "3")),
  maxTurns: Number(input("max-turns", "40")),
};

console.log(`greenbump · ${req.library} · budget $${req.maxBudgetUsd} · max ${req.maxTurns} turns`);

let outcome;
try {
  outcome = await attemptFix(req);
} catch (err) {
  await summary(`### greenbump\n\nAttempt errored: ${(err as Error).message}\n\nYour build is unaffected.`);
  process.exit(0);
}

const cost = `$${outcome.costUsd.toFixed(2)}`;

if (!outcome.fixed) {
  // Staying silent is a first-class outcome. Leave no branch, no PR, no noise.
  await run("git", ["checkout", "--", "."], { cwd: req.cwd, timeoutMs: 60_000 });
  await summary(
    `### greenbump — no fix proposed\n\n` +
      `${outcome.reason}\n\n` +
      `Nothing was changed. Cost ${cost} across ${outcome.turns} turns.`,
  );
  process.exit(0);
}

// Only now, with a green suite and untouched tests, do we write anything.
const branch = input("branch", `greenbump/${req.library}-${Date.now().toString(36)}`);
const token = process.env.GITHUB_TOKEN || input("github-token");
const repo = process.env.GITHUB_REPOSITORY;

const git = (args: string[]) => run("git", args, { cwd: req.cwd, timeoutMs: 120_000 });

await git(["config", "user.name", "greenbump"]);
await git(["config", "user.email", "bot@greenbump.dev"]);
await git(["checkout", "-b", branch]);
await git(["add", "--", ...outcome.filesChanged]);
await git([
  "commit",
  "-m",
  `fix: update code for ${req.library} ${req.toVersion ?? "major upgrade"}\n\n` +
    `${outcome.reason}\n\nVerified: the existing test suite passes and no test files were modified.`,
]);

if (token && repo) {
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  const push = await git(["push", url, `HEAD:${branch}`]);
  if (!push.ok) {
    await summary(`### greenbump\n\nFix verified but push failed:\n\n\`\`\`\n${push.stderr.slice(-500)}\n\`\`\``);
    process.exit(0);
  }
} else {
  await summary(`### greenbump\n\nFix verified on local branch \`${branch}\`, but no token was available to push.`);
  process.exit(0);
}

await summary(
  `### greenbump — fix ready ✅\n\n` +
    `**${req.library}${req.toVersion ? ` → ${req.toVersion}` : ""}** · ${outcome.reason}\n\n` +
    `| | |\n|---|---|\n` +
    `| Branch | \`${branch}\` |\n` +
    `| Tests before | ${outcome.before.counts.failed} failed, ${outcome.before.counts.passed} passed |\n` +
    `| Tests after | ${outcome.after?.counts.passed ?? 0} passed |\n` +
    `| Files changed | ${outcome.filesChanged.length} |\n` +
    `| Cost | ${cost} over ${outcome.turns} turns |\n\n` +
    `Open a pull request from \`${branch}\` to review the diff.`,
);
