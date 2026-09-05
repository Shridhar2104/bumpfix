import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  console.error("ANTHROPIC_API_KEY is required — eval attempts are real agent runs");
  process.exit(1);
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

const results: CaseResult[] = [];

for (const [i, c] of cases.entries()) {
  console.log(`\n[${i + 1}/${cases.length}] ${c.repo} @ ${c.parentSha.slice(0, 8)}`);
  const started = Date.now();
  const record = (result: CaseResult["result"], reason: string, costUsd = 0, turns = 0) => {
    console.log(`  ${result}: ${reason}${costUsd ? ` ($${costUsd.toFixed(2)})` : ""}`);
    results.push({ id: c.id, repo: c.repo, sha: c.parentSha, result, reason, costUsd, turns, ms: Date.now() - started });
  };

  const prep = await prepareCase(c.repo, c.parentSha);
  if (!prep.ok) {
    record("skipped", `${prep.stage}: ${prep.reason}`);
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
      record("skipped", `bump install failed: ${tail(bump.stderr, 3)}`);
      continue;
    }

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
    record(kind, out.reason, out.costUsd, out.turns);
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
    `| [${r.repo}](https://github.com/${r.repo}/commit/${r.sha}) | ${r.result} | ${r.reason.slice(0, 80)} | $${r.costUsd.toFixed(2)} | ${(r.ms / 60_000).toFixed(1)}m |`,
);
const md = [
  `# greenbump eval — ${lib} v${target.fromMajor} → v${target.toMajor}`,
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
