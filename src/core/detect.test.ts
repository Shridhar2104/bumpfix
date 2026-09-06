import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMajorBumps } from "./detect.ts";

const diff = (file: string, body: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}`;

test("detects a pinned requirements.txt bump across a major", () => {
  const bumps = detectMajorBumps(diff("requirements.txt", "-pydantic==1.10.13\n+pydantic==2.9.2\n"));
  assert.deepEqual(bumps, [
    { library: "pydantic", fromVersion: "1.10.13", toVersion: "2.9.2", manifest: "requirements.txt" },
  ]);
});

test("ignores a bump inside the same major", () => {
  const bumps = detectMajorBumps(diff("requirements.txt", "-pydantic==1.9.0\n+pydantic==1.10.13\n"));
  assert.deepEqual(bumps, []);
});

test("0.x to 1.0 counts as a major bump", () => {
  const bumps = detectMajorBumps(diff("requirements.txt", "-httpx==0.27.2\n+httpx==1.0.0\n"));
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].library, "httpx");
});

test("reads a poetry constraint in pyproject.toml", () => {
  const bumps = detectMajorBumps(diff("pyproject.toml", '-pydantic = "^1.10"\n+pydantic = "^2.9"\n'));
  assert.deepEqual(bumps, [
    { library: "pydantic", fromVersion: "1.10", toVersion: "2.9", manifest: "pyproject.toml" },
  ]);
});

test("reads a PEP 621 dependencies list entry", () => {
  const bumps = detectMajorBumps(diff("pyproject.toml", '-    "sqlalchemy>=1.4,<2",\n+    "sqlalchemy>=2.0,<3",\n'));
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].library, "sqlalchemy");
  assert.equal(bumps[0].toVersion, "2.0");
});

test("reads a poetry.lock name/version pair using diff context", () => {
  const body = ' name = "pydantic"\n-version = "1.10.13"\n+version = "2.9.2"\n';
  const bumps = detectMajorBumps(diff("poetry.lock", body));
  assert.deepEqual(bumps, [
    { library: "pydantic", fromVersion: "1.10.13", toVersion: "2.9.2", manifest: "poetry.lock" },
  ]);
});

test("reads a Pipfile.lock single-line JSON entry", () => {
  const body =
    '-        "pydantic": {"hashes": ["sha256:x"], "version": "==1.10.13"},\n' +
    '+        "pydantic": {"hashes": ["sha256:y"], "version": "==2.9.2"},\n';
  const bumps = detectMajorBumps(diff("Pipfile.lock", body));
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].fromVersion, "1.10.13");
});

test("merges manifest and lockfile changes into one bump, preferring precision", () => {
  const d =
    diff("pyproject.toml", '-pydantic = "^1.10"\n+pydantic = "^2"\n') +
    "\n" +
    diff("poetry.lock", ' name = "pydantic"\n-version = "1.10.13"\n+version = "2.9.2"\n');
  const bumps = detectMajorBumps(d);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].fromVersion, "1.10.13");
  assert.equal(bumps[0].toVersion, "2.9.2");
});

test("normalises name variants so underscore and dash dedupe", () => {
  const d =
    diff("requirements.txt", "-pydantic_settings==1.0.0\n+pydantic_settings==2.5.0\n") +
    "\n" +
    diff("uv.lock", ' name = "pydantic-settings"\n-version = "1.0.0"\n+version = "2.5.0"\n');
  const bumps = detectMajorBumps(d);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].library, "pydantic-settings");
});

test("ignores the project's own version field in pyproject.toml", () => {
  const bumps = detectMajorBumps(diff("pyproject.toml", '-version = "1.0.0"\n+version = "2.0.0"\n'));
  assert.deepEqual(bumps, []);
});

test("ignores the project's own version bump even with a name context line", () => {
  const body = ' name = "myproject"\n-version = "1.4.0"\n+version = "2.0.0"\n';
  const bumps = detectMajorBumps(diff("pyproject.toml", body));
  assert.deepEqual(bumps, []);
});

test("ignores changes in non-manifest files", () => {
  const bumps = detectMajorBumps(diff("app/models.py", "-pydantic==1.0\n+pydantic==2.0\n"));
  assert.deepEqual(bumps, []);
});

test("handles extras in the requirement name", () => {
  const bumps = detectMajorBumps(diff("requirements.txt", "-pydantic[email]==1.10.13\n+pydantic[email]==2.9.2\n"));
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].library, "pydantic");
});

test("a downgrade is not a bump", () => {
  const bumps = detectMajorBumps(diff("requirements.txt", "-pydantic==2.9.2\n+pydantic==1.10.13\n"));
  assert.deepEqual(bumps, []);
});

test("reads a real pretty-printed Pipfile.lock (name and version on separate lines)", () => {
  const body =
    '         "pydantic": {\n' +
    '             "hashes": [\n' +
    '-                "sha256:aaa"\n' +
    '+                "sha256:bbb"\n' +
    "             ],\n" +
    '             "index": "pypi",\n' +
    '-            "version": "==1.10.13"\n' +
    '+            "version": "==2.9.2"\n' +
    "         },\n";
  const bumps = detectMajorBumps(diff("Pipfile.lock", body));
  assert.deepEqual(bumps, [
    { library: "pydantic", fromVersion: "1.10.13", toVersion: "2.9.2", manifest: "Pipfile.lock" },
  ]);
});

test("Pipfile.lock section and meta objects never become packages", () => {
  const body =
    '     "_meta": {\n' +
    '         "requires": {\n' +
    '-            "python_version": "3.10"\n' +
    '+            "python_version": "3.11"\n' +
    "         }\n" +
    "     },\n" +
    '     "default": {\n';
  assert.deepEqual(detectMajorBumps(diff("Pipfile.lock", body)), []);
});

test("detects a bump when the old manifest was deleted and a new one added", () => {
  const d =
    "diff --git a/requirements.txt b/requirements.txt\n" +
    "--- a/requirements.txt\n" +
    "+++ /dev/null\n" +
    "@@ -1,2 +0,0 @@\n" +
    "-flask==2.0.1\n" +
    "-pydantic==1.10.13\n" +
    "diff --git a/pyproject.toml b/pyproject.toml\n" +
    "--- /dev/null\n" +
    "+++ b/pyproject.toml\n" +
    "@@ -0,0 +1,2 @@\n" +
    '+pydantic = "^2.9"\n';
  const bumps = detectMajorBumps(d);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].library, "pydantic");
  assert.equal(bumps[0].fromVersion, "1.10.13");
  assert.equal(bumps[0].toVersion, "2.9");
});
