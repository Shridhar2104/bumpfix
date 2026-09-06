import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedBump } from "./detect.ts";
import type { TestCounts } from "./pytest.ts";

/** One library attempted during a run. */
export type AttemptOutcome = {
  library: string;
  fromVersion?: string;
  toVersion?: string;
  fixed: boolean;
  reason: string;
  costUsd: number;
  turns: number;
  testsBefore?: TestCounts;
  testsAfter?: TestCounts;
  filesChanged: string[];
  durationMs: number;
};

export type DeliveryOutcome = {
  mode: "pr-branch" | "fix-branch" | "local" | "none";
  branch?: string;
  pushed: boolean;
  commented: boolean;
  note?: string;
};

/**
 * The structured record every run emits. This schema is the seam the hosted
 * App will meter and bill on later — extend it additively and bump `schema`.
 */
export type OutcomeRecord = {
  schema: 1;
  repo?: string;
  pr?: number;
  startedAt: string;
  finishedAt: string;
  detected: DetectedBump[];
  attempts: AttemptOutcome[];
  delivery: DeliveryOutcome;
  totalCostUsd: number;
};

export const totalCost = (attempts: AttemptOutcome[]) =>
  Math.round(attempts.reduce((sum, a) => sum + a.costUsd, 0) * 100) / 100;

/** Write the record where CI can pick it up, and expose it as step outputs. */
export async function writeOutcomeFile(record: OutcomeRecord): Promise<string> {
  // `fixed` goes out first and on its own: a full RUNNER_TEMP must not also
  // cost downstream steps the one output they gate on.
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `fixed=${record.attempts.some((a) => a.fixed)}\n`,
    ).catch(() => {});
  }
  const path = join(process.env.RUNNER_TEMP || tmpdir(), "bumpfix-outcome.json");
  await writeFile(path, JSON.stringify(record, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `outcome-file=${path}\n`);
  }
  return path;
}

/** Markdown for the step summary — the same numbers on every exit path. */
export function renderSummary(record: OutcomeRecord): string {
  const lines = ["### bumpfix"];
  if (!record.attempts.length) {
    lines.push("", "No major-version bumps detected. Nothing to do.");
    return lines.join("\n");
  }

  for (const a of record.attempts) {
    const version =
      a.fromVersion && a.toVersion ? `${a.fromVersion} → ${a.toVersion}` : "major upgrade";
    lines.push("", `**${a.library}** (${version}) — ${a.fixed ? "fixed ✅" : "no fix proposed"}`, "", a.reason);
    if (a.fixed) {
      lines.push(
        "",
        "| | |",
        "|---|---|",
        `| Tests before | ${a.testsBefore?.failed ?? "?"} failed, ${a.testsBefore?.passed ?? "?"} passed |`,
        `| Tests after | ${a.testsAfter?.passed ?? 0} passed |`,
        `| Files changed | ${a.filesChanged.join(", ")} |`,
        `| Cost | $${a.costUsd.toFixed(2)} over ${a.turns} turns |`,
      );
    }
  }

  const d = record.delivery;
  if (d.mode === "pr-branch" && d.pushed) {
    lines.push("", `Fix pushed to this PR's branch (\`${d.branch}\`).`);
  } else if (d.mode === "fix-branch" && d.pushed) {
    lines.push("", `Fix pushed to \`${d.branch}\`${d.note ? ` — ${d.note}` : ""}. Open a PR to review.`);
  } else if (d.mode === "local") {
    lines.push("", `No token available, so the fix stayed on local branch \`${d.branch}\`.`);
  } else if (d.note) {
    lines.push("", d.note);
  }

  lines.push("", `Total cost $${record.totalCostUsd.toFixed(2)}.`);
  return lines.join("\n");
}
