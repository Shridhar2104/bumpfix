import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSummary, totalCost, type AttemptOutcome, type OutcomeRecord } from "./outcome.ts";

const attempt = (over: Partial<AttemptOutcome>): AttemptOutcome => ({
  library: "pydantic",
  fromVersion: "1.10.13",
  toVersion: "2.9.2",
  fixed: false,
  reason: "suite still red",
  costUsd: 1.25,
  turns: 12,
  testsBefore: { passed: 10, failed: 3, errors: 0, skipped: 0 },
  filesChanged: [],
  durationMs: 60_000,
  ...over,
});

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

test("totalCost sums and rounds to cents", () => {
  assert.equal(totalCost([attempt({ costUsd: 1.111 }), attempt({ costUsd: 2.222 })]), 3.33);
});

test("summary for a run with nothing detected", () => {
  const md = renderSummary(record({}));
  assert.match(md, /No major-version bumps detected/);
});

test("summary for a successful in-place fix names the branch and numbers", () => {
  const a = attempt({
    fixed: true,
    reason: "13 passed, 13 collected, 2 file(s) changed",
    testsAfter: { passed: 13, failed: 0, errors: 0, skipped: 0 },
    filesChanged: ["app/models.py", "app/config.py"],
  });
  const md = renderSummary(
    record({
      attempts: [a],
      delivery: { mode: "pr-branch", branch: "dependabot/pip/pydantic-2.9.2", pushed: true, commented: true },
      totalCostUsd: 1.25,
    }),
  );
  assert.match(md, /pydantic/);
  assert.match(md, /fixed ✅/);
  assert.match(md, /3 failed, 10 passed/);
  assert.match(md, /13 passed/);
  assert.match(md, /app\/models\.py/);
  assert.match(md, /dependabot\/pip\/pydantic-2\.9\.2/);
  assert.match(md, /\$1\.25/);
});

test("summary for a failed attempt stays quiet about delivery", () => {
  const md = renderSummary(record({ attempts: [attempt({})], totalCostUsd: 1.25 }));
  assert.match(md, /no fix proposed/);
  assert.doesNotMatch(md, /pushed/i);
});

test("summary notes the fallback branch and why", () => {
  const md = renderSummary(
    record({
      attempts: [attempt({ fixed: true, filesChanged: ["a.py"], testsAfter: { passed: 13, failed: 0, errors: 0, skipped: 0 } })],
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
  assert.match(md, /bumpfix\/pydantic-x1/);
  assert.match(md, /moved while bumpfix was running/);
});
