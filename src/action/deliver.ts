import { run } from "../core/exec.ts";
import type { PrContext } from "./context.ts";

export type PushPlan = { mode: "pr-branch" | "fix-branch"; branch: string; note?: string };

/**
 * Decide where a verified fix goes. In-place on the PR branch is the product;
 * any doubt about the state of that branch demotes the push to a separate fix
 * branch instead — never guess with someone else's ref.
 */
export function choosePushTarget(opts: {
  pr: PrContext | null;
  /** HEAD at the moment the action started, before bumpfix committed. */
  checkoutSha: string;
  /** Remote sha of the PR head branch right now, null when unreadable. */
  remoteHeadSha: string | null;
  fallbackBranch: string;
}): PushPlan {
  const { pr, checkoutSha, remoteHeadSha, fallbackBranch } = opts;
  if (!pr) {
    return { mode: "fix-branch", branch: fallbackBranch, note: "not a pull_request run" };
  }
  if (checkoutSha !== pr.headSha) {
    return {
      mode: "fix-branch",
      branch: fallbackBranch,
      note:
        "checked-out commit is not the PR head — set `ref: ${{ github.head_ref }}` on actions/checkout to enable in-place fixes",
    };
  }
  if (remoteHeadSha !== pr.headSha) {
    return {
      mode: "fix-branch",
      branch: fallbackBranch,
      note: "the PR branch moved while bumpfix was running",
    };
  }
  return { mode: "pr-branch", branch: pr.headRef };
}

const git = (cwd: string, args: string[]) => run("git", args, { cwd, timeoutMs: 120_000 });

export async function commitFix(cwd: string, files: string[], message: string): Promise<boolean> {
  // `git status --porcelain` paths are repo-root-relative; when the action's
  // working-directory is a subdirectory, staging them from `cwd` would look
  // for e.g. backend/backend/app.py and silently lose the fix.
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = top.stdout.trim() || cwd;
  await git(root, ["config", "user.name", "bumpfix"]);
  await git(root, ["config", "user.email", "bot@bumpfix.dev"]);
  await git(root, ["add", "--", ...files]);
  const r = await git(root, ["commit", "-m", message]);
  return r.ok;
}

export async function remoteHead(cwd: string, url: string, branch: string): Promise<string | null> {
  const r = await git(cwd, ["ls-remote", url, `refs/heads/${branch}`]);
  const sha = r.stdout.split(/\s/)[0];
  return r.ok && sha ? sha : null;
}

export async function push(cwd: string, url: string, branch: string): Promise<{ ok: boolean; stderr: string }> {
  const r = await git(cwd, ["push", url, `HEAD:refs/heads/${branch}`]);
  return { ok: r.ok, stderr: r.stderr };
}
