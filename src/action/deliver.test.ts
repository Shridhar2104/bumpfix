import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePushTarget } from "./deliver.ts";
import type { PrContext } from "./context.ts";

const pr: PrContext = {
  repo: "acme/app",
  prNumber: 7,
  headRef: "dependabot/pip/pydantic-2.9.2",
  headSha: "aaa111",
  baseSha: "bbb222",
};

test("pushes in place when checkout and remote both match the PR head", () => {
  const plan = choosePushTarget({ pr, checkoutSha: "aaa111", remoteHeadSha: "aaa111", fallbackBranch: "gb/x" });
  assert.deepEqual(plan, { mode: "pr-branch", branch: "dependabot/pip/pydantic-2.9.2" });
});

test("falls back when the run is not a pull_request event", () => {
  const plan = choosePushTarget({ pr: null, checkoutSha: "aaa111", remoteHeadSha: null, fallbackBranch: "gb/x" });
  assert.equal(plan.mode, "fix-branch");
  assert.equal(plan.branch, "gb/x");
});

test("falls back when the checkout is not the PR head (merge ref)", () => {
  const plan = choosePushTarget({ pr, checkoutSha: "merge999", remoteHeadSha: "aaa111", fallbackBranch: "gb/x" });
  assert.equal(plan.mode, "fix-branch");
  assert.match(plan.note ?? "", /github\.head_ref/);
});

test("falls back when the PR branch moved during the run", () => {
  const plan = choosePushTarget({ pr, checkoutSha: "aaa111", remoteHeadSha: "ccc333", fallbackBranch: "gb/x" });
  assert.equal(plan.mode, "fix-branch");
  assert.match(plan.note ?? "", /moved/);
});

test("falls back when the remote head is unreadable", () => {
  const plan = choosePushTarget({ pr, checkoutSha: "aaa111", remoteHeadSha: null, fallbackBranch: "gb/x" });
  assert.equal(plan.mode, "fix-branch");
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitFix } from "./deliver.ts";

test("commitFix stages root-relative paths even when cwd is a subdirectory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-test-"));
  const sh = (args: string[]) => execFileSync("git", args, { cwd: dir });
  try {
    sh(["init", "-q", "--initial-branch=main"]);
    sh(["config", "user.email", "t@t"]);
    sh(["config", "user.name", "t"]);
    mkdirSync(join(dir, "backend/app"), { recursive: true });
    writeFileSync(join(dir, "backend/app/models.py"), "x\n");
    sh(["add", "-A"]);
    sh(["commit", "-qm", "init"]);
    writeFileSync(join(dir, "backend/app/models.py"), "y\n");

    // cwd is the subdir; the path is repo-root-relative, as git status emits it.
    const ok = await commitFix(join(dir, "backend"), ["backend/app/models.py"], "fix");
    assert.equal(ok, true);
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir }).toString().trim();
    assert.equal(subject, "fix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
