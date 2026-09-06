import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { attemptFix } from "../core/agent.ts";
import { run, tail } from "../core/exec.ts";
import { prepareCase, venvEnv } from "./sandbox.ts";
import { TARGETS } from "./targets.ts";
import type { CorpusEntry } from "./types.ts";

/**
 * Score the fix engine against mined, validated migration cases.
 *
 * For each case: check out the pre-migration tree, install its deps, bump the
 * target library across the major boundary, then let the engine try to make
 * the suite green. Serial on purpose — every attempt is real API spend.
 *
 * Usage: ANTHROPIC_API_KEY=... npm run eval pydantic -- --n=5 --budget=3
 */

const lib = process.argv[2] ?? "pydantic";
const limit = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? Infinity);
const budget = Number(process.argv.find((a) => a.startsWith("--budget="))?.slice(9) ?? 3);

const target = TARGETS[lib];
if (!target) {
  console.error(`unknown target "${lib}" — known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  // The Agent SDK falls back to the local Claude Code login. Costs are then
  // subscription quota, not API dollars — total_cost_usd is still reported.
  console.warn("no ANTHROPIC_API_KEY — using the local Claude Code subscription login");
}

const raw = await readFile(`corpus/${lib}.runnable.jsonl`, "utf8");
const cases = raw
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CorpusEntry)
  .slice(0, limit);

type CaseResult = {
  id: string;
  repo: string;
  sha: string;
  result: "fixed" | "not-fixed" | "skipped";
  reason: string;
  costUsd: number;
  turns: number;
  ms: number;
};

/** Outcomes that say the case could not test the engine, not that it failed. */
const SKIP_REASONS = ["suite already green", "no tests collected"];

/**
 * Every finished case is appended here immediately, and completed ids are
 * skipped on the next run — a crash mid-run costs one case, not the whole
 * (expensive, serial) sweep. Delete the file to force a fresh sweep.
 */
const PROGRESS = `corpus/${lib}.eval-progress.jsonl`;
const results: CaseResult[] = existsSync(PROGRESS)
  ? (await readFile(PROGRESS, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as CaseResult)
  : [];
const doneIds = new Set(results.map((r) => r.id));
if (doneIds.size) console.log(`resuming — ${doneIds.size} case(s) already recorded in ${PROGRESS}`);

for (const [i, c] of cases.entries()) {
  if (doneIds.has(c.id)) continue;
  console.log(`\n[${i + 1}/${cases.length}] ${c.repo} @ ${c.parentSha.slice(0, 8)}`);
  const started = Date.now();
  const record = async (result: CaseResult["result"], reason: string, costUsd = 0, turns = 0) => {
    console.log(`  ${result}: ${reason}${costUsd ? ` ($${costUsd.toFixed(2)})` : ""}`);
    const entry = { id: c.id, repo: c.repo, sha: c.parentSha, result, reason, costUsd, turns, ms: Date.now() - started };
    results.push(entry);
    await appendFile(PROGRESS, JSON.stringify(entry) + "\n");
  };

  const prep = await prepareCase(c.repo, c.parentSha);
  if (!prep.ok) {
    await record("skipped", `${prep.stage}: ${prep.reason}`);
    continue;
  }
  const { dir, python } = prep.prepared;

  try {
    const spec = c.version
      ? `${lib}==${c.version.to}`
      : `${lib}>=${target.toMajor},<${target.toMajor + 1}`;
    const bump = await run("uv", ["pip", "install", spec], {
      cwd: dir,
      timeoutMs: 300_000,
      env: venvEnv(dir),
    });
    if (!bump.ok) {
      await record("skipped", `bump install failed: ${tail(bump.stderr, 3)}`);
      continue;
    }

    try {
      const out = await attemptFix({
        cwd: dir,
        library: lib,
        fromVersion: c.version?.from,
        toVersion: c.version?.to,
        python,
        maxBudgetUsd: budget,
        maxTurns: 40,
        // Same rationale as the validator: we measure whether code works, not
        // whether a 2024 warning policy survives 2026 transitive deps.
        pytestArgs: ["--override-ini=filterwarnings="],
      });
      const kind = out.fixed
        ? "fixed"
        : SKIP_REASONS.some((s) => out.reason.startsWith(s))
          ? "skipped"
          : "not-fixed";
      await record(kind, out.reason, out.costUsd, out.turns);
    } catch (err) {
      // One crashed case must not take down the rest of the sweep.
      await record("not-fixed", `crashed: ${((err as Error).message ?? String(err)).slice(0, 120)}`, budget);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const attempted = results.filter((r) => r.result !== "skipped");
const fixed = attempted.filter((r) => r.result === "fixed");
const costs = attempted.map((r) => r.costUsd).sort((a, b) => a - b);
const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
const rate = attempted.length ? Math.round((100 * fixed.length) / attempted.length) : 0;

await mkdir("docs/evals", { recursive: true });
await writeFile(
  `docs/evals/${lib}-results.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), budget, results }, null, 2) + "\n",
);

const rows = results.map(
  (r) =>
    `| [${r.repo}](https://github.com/${r.repo}/commit/${r.sha}) | ${r.result} | ${r.reason.slice(0, 80)} | $${r.costUsd.toFixed(2)} | ${r.ms ? (r.ms / 60_000).toFixed(1) + "m" : "—"} |`,
);
const md = [
  `# bumpfix eval — ${lib} v${target.fromMajor} → v${target.toMajor}`,
  "",
  `Generated ${new Date().toISOString().slice(0, 10)} · budget $${budget}/case · ${cases.length} mined cases`,
  "",
  `**Fixed ${fixed.length} of ${attempted.length} attempted (${rate}%)** · median cost $${median.toFixed(2)} per attempt · ${results.length - attempted.length} skipped (bump did not break the suite, or the environment failed)`,
  "",
  "| Case | Result | Reason | Cost | Time |",
  "|---|---|---|---|---|",
  ...rows,
  "",
].join("\n");
await writeFile(`docs/evals/${lib}-v${target.fromMajor}-v${target.toMajor}.md`, md);

console.log(`\nfixed ${fixed.length}/${attempted.length} (${rate}%) · wrote docs/evals/${lib}-v${target.fromMajor}-v${target.toMajor}.md`);
