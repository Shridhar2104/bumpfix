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
