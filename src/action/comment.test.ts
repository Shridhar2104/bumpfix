import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommentBody } from "./comment.ts";
import type { OutcomeRecord } from "../core/outcome.ts";

const record = (over: Partial<OutcomeRecord>): OutcomeRecord => ({
  schema: 1,
  startedAt: "2026-09-05T00:00:00Z",
  finishedAt: "2026-09-05T00:05:00Z",
  detected: [],
  attempts: [],
  delivery: { mode: "none", pushed: false, commented: false },
  totalCostUsd: 0,
  ...over,
});

const fixedAttempt = {
  library: "pydantic",
  fromVersion: "1.10.13",
  toVersion: "2.9.2",
  fixed: true,
  reason: "13 passed, 13 collected, 2 file(s) changed",
  costUsd: 1.25,
  turns: 12,
  filesChanged: ["app/models.py", "app/config.py"],
  durationMs: 60_000,
};

test("no comment when nothing was fixed", () => {
  assert.equal(buildCommentBody(record({ attempts: [{ ...fixedAttempt, fixed: false }] })), null);
  assert.equal(buildCommentBody(record({})), null);
});

test("comment for an in-place fix names the library, files, and cost", () => {
  const body = buildCommentBody(
    record({
      attempts: [fixedAttempt],
      delivery: { mode: "pr-branch", branch: "dependabot/pip/pydantic-2.9.2", pushed: true, commented: false },
      totalCostUsd: 1.25,
    }),
  );
  assert.ok(body);
  assert.match(body, /pydantic 1\.10\.13 → 2\.9\.2/);
  assert.match(body, /`app\/models\.py`/);
  assert.match(body, /pushed to this branch/);
  assert.match(body, /\$1\.25/);
});

test("comment for a fallback push points at the fix branch and says why", () => {
  const body = buildCommentBody(
    record({
      attempts: [fixedAttempt],
      delivery: {
        mode: "fix-branch",
        branch: "bumpfix/pydantic-x1",
        pushed: true,
        commented: false,
        note: "the PR branch moved while bumpfix was running",
      },
      totalCostUsd: 1.25,
    }),
  );
  assert.ok(body);
  assert.match(body, /`bumpfix\/pydantic-x1`/);
  assert.match(body, /moved while bumpfix was running/);
});
