import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPaths, rejectFromPaths, rejectFromSearch } from "./quality.ts";
import type { RepoHit } from "./github.ts";

const repo = (over: Partial<RepoHit> = {}): RepoHit => ({
  full_name: "acme/widget",
  stargazers_count: 500,
  pushed_at: "2026-01-15T00:00:00Z",
  fork: false,
  archived: false,
  default_branch: "main",
  size: 5000,
  ...over,
});

const GOOD = [
  "pyproject.toml",
  "poetry.lock",
  ".github/workflows/ci.yml",
  "src/app.py",
  "tests/test_a.py",
  "tests/test_b.py",
  "tests/test_c.py",
];

test("reads quality signals off the file tree", () => {
  const q = assessPaths(GOOD);
  assert.deepEqual(q, {
    testFiles: 3, hasTests: true, hasCI: true, hasManifest: true, hasLockfile: true,
  });
});

test("recognises requirements.txt and _test.py naming", () => {
  const q = assessPaths(["requirements.txt", "a_test.py", "b_test.py", "c_test.py"]);
  assert.equal(q.hasManifest, true);
  assert.equal(q.testFiles, 3);
  assert.equal(q.hasLockfile, false);
});

test("accepts a repo that clears both gates", () => {
  assert.equal(rejectFromSearch(repo()), null);
  assert.equal(rejectFromPaths(assessPaths(GOOD)), null);
});

// Each of these is a failure mode observed in the message-first corpus.
test("rejects the no-manifest case", () => {
  assert.equal(rejectFromPaths(assessPaths(["tests/test_a.py", "tests/test_b.py", "tests/test_c.py"])), "no dependency manifest");
});

test("rejects the no-tests case", () => {
  assert.equal(rejectFromPaths(assessPaths(["pyproject.toml", "src/app.py"])), "no test files");
});

test("rejects a token test suite", () => {
  assert.equal(rejectFromPaths(assessPaths(["pyproject.toml", "tests/test_a.py"])), "only 1 test file(s)");
});

test("rejects forks, archives, toys and abandonware", () => {
  assert.equal(rejectFromSearch(repo({ fork: true })), "fork");
  assert.equal(rejectFromSearch(repo({ archived: true })), "archived");
  assert.equal(rejectFromSearch(repo({ stargazers_count: 3 })), "only 3 stars");
  assert.equal(rejectFromSearch(repo({ pushed_at: "2021-04-02T00:00:00Z" })), "stale since 2021-04");
});

test("cheap gates run before any extra API call", () => {
  // A fork with a perfect tree is still rejected without ever fetching the tree.
  assert.equal(rejectFromSearch(repo({ fork: true })), "fork");
  assert.equal(rejectFromPaths(assessPaths(GOOD)), null);
});
