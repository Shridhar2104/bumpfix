import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrContext } from "./context.ts";

const payload = {
  pull_request: {
    number: 7,
    head: { ref: "dependabot/pip/pydantic-2.9.2", sha: "aaa111" },
    base: { sha: "bbb222" },
  },
};

test("parses a pull_request event", () => {
  assert.deepEqual(parsePrContext("pull_request", "acme/app", payload), {
    repo: "acme/app",
    prNumber: 7,
    headRef: "dependabot/pip/pydantic-2.9.2",
    headSha: "aaa111",
    baseSha: "bbb222",
  });
});

test("returns null for non-PR events", () => {
  assert.equal(parsePrContext("push", "acme/app", payload), null);
  assert.equal(parsePrContext(undefined, "acme/app", payload), null);
});

test("returns null when the payload is malformed", () => {
  assert.equal(parsePrContext("pull_request", "acme/app", {}), null);
  assert.equal(parsePrContext("pull_request", "acme/app", { pull_request: { number: 7 } }), null);
  assert.equal(parsePrContext("pull_request", undefined, payload), null);
});
