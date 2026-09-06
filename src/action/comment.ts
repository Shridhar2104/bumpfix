import type { OutcomeRecord } from "../core/outcome.ts";

/** One comment per run, and only when something was actually fixed. */
export function buildCommentBody(record: OutcomeRecord): string | null {
  const fixed = record.attempts.filter((a) => a.fixed);
  if (!fixed.length) return null;

  const lines = ["### bumpfix fixed this upgrade ✅"];
  for (const a of fixed) {
    const version = a.fromVersion && a.toVersion ? ` ${a.fromVersion} → ${a.toVersion}` : "";
    lines.push(
      "",
      `**${a.library}${version}** — ${a.reason}`,
      "",
      `Files changed: ${a.filesChanged.map((f) => `\`${f}\``).join(", ")}`,
    );
  }

  const d = record.delivery;
  if (d.mode === "pr-branch") {
    lines.push(
      "",
      "The fix was pushed to this branch. Note: pushes made with the default " +
        "`GITHUB_TOKEN` don't re-trigger workflows — re-run checks manually, or " +
        "configure a PAT/App token in `github-token` to have them rerun automatically.",
    );
  } else if (d.mode === "fix-branch" && d.branch) {
    lines.push("", `The fix was pushed to \`${d.branch}\` (${d.note ?? "in-place push was not possible"}).`);
  }

  lines.push(
    "",
    `_Verified against your existing test suite; no test files were touched. Total cost $${record.totalCostUsd.toFixed(2)}._`,
  );
  return lines.join("\n");
}

/** Best-effort: a failed comment must never fail the run — the fix is already pushed. */
export async function postComment(
  token: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "bumpfix",
      },
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
