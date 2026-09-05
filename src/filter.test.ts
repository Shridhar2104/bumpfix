import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, detectMarkers, parseVersionChange } from "./filter.ts";
import { TARGETS } from "./targets.ts";
import type { ChangedFile } from "./types.ts";

const pydantic = TARGETS.pydantic;

const file = (filename: string, patch: string): ChangedFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});

test("reads a pinned version bump across the major boundary", () => {
  const v = parseVersionChange(
    [file("requirements.txt", "@@\n-pydantic==1.10.13\n+pydantic==2.9.2\n")],
    pydantic,
  );
  assert.deepEqual(v, { from: "1.10.13", to: "2.9.2" });
});

test("reads a poetry-style constraint", () => {
  const v = parseVersionChange(
    [file("pyproject.toml", '@@\n-pydantic = "^1.10"\n+pydantic = "^2.9"\n')],
    pydantic,
  );
  assert.deepEqual(v, { from: "1.10", to: "2.9" });
});

test("ignores a bump that stays inside the old major", () => {
  const v = parseVersionChange(
    [file("requirements.txt", "@@\n-pydantic==1.9.0\n+pydantic==1.10.13\n")],
    pydantic,
  );
  assert.equal(v, null);
});

test("ignores versions on lines that do not name the package", () => {
  const v = parseVersionChange(
    [file("requirements.txt", "@@\n-requests==1.2.3\n+requests==2.0.0\n")],
    pydantic,
  );
  assert.equal(v, null);
});

test("does not mistake diff headers for changed lines", () => {
  const v = parseVersionChange(
    [file("requirements.txt", "--- a/pydantic-1.0\n+++ b/pydantic-2.0\n")],
    pydantic,
  );
  assert.equal(v, null);
});

test("accepts a commit that bumps the manifest and edits source", () => {
  const verdict = classify(
    [
      file("requirements.txt", "@@\n-pydantic==1.10.13\n+pydantic==2.9.2\n"),
      file("app/models.py", "@@\n-    @validator('total')\n+    @field_validator('total')\n"),
    ],
    1,
    pydantic,
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.codeFiles.length, 1);
    assert.equal(verdict.manifestFiles.length, 1);
    assert.deepEqual(verdict.version, { from: "1.10.13", to: "2.9.2" });
  }
});

test("rejects a version-only bump — there is no label to learn from", () => {
  const verdict = classify(
    [file("requirements.txt", "@@\n-pydantic==1.10.13\n+pydantic==2.9.2\n")],
    1,
    pydantic,
  );
  assert.deepEqual(verdict, { ok: false, reason: "noCode" });
});

test("detects known API markers in a diff", () => {
  const found = detectMarkers(
    [
      file(
        "app/models.py",
        "@@\n-    @validator('total')\n-        return self.dict()\n" +
          "+    @field_validator('total')\n+        return self.model_dump()\n",
      ),
    ],
    pydantic,
  );
  assert.deepEqual(found, ["dict", "validator"]);
});

test("accepts a code-only commit when the bump landed separately", () => {
  const verdict = classify(
    [file("app/models.py", "@@\n-    @validator('total')\n+    @field_validator('total')\n")],
    1,
    pydantic,
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.evidence, "markers");
    assert.equal(verdict.version, null);
    assert.deepEqual(verdict.markers, ["validator"]);
  }
});

test("a marker needs both sides — removal alone is not a migration", () => {
  const verdict = classify(
    [file("app/models.py", "@@\n-    @validator('total')\n+    pass\n")],
    1,
    pydantic,
  );
  assert.deepEqual(verdict, { ok: false, reason: "noSignal" });
});

test("prefers the manifest signal and still records markers", () => {
  const verdict = classify(
    [
      file("requirements.txt", "@@\n-pydantic==1.10.13\n+pydantic==2.9.2\n"),
      file("app/models.py", "@@\n-    @validator('t')\n+    @field_validator('t')\n"),
    ],
    1,
    pydantic,
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.evidence, "manifest");
    assert.deepEqual(verdict.markers, ["validator"]);
  }
});

test("rejects merge commits", () => {
  const verdict = classify([file("requirements.txt", "-pydantic==1.0\n+pydantic==2.0\n")], 2, pydantic);
  assert.deepEqual(verdict, { ok: false, reason: "merge" });
});

test("rejects unrelated source edits", () => {
  const verdict = classify([file("app/models.py", "@@\n-x\n+y\n")], 1, pydantic);
  assert.deepEqual(verdict, { ok: false, reason: "noSignal" });
});

test("rejects sweeping refactors above the file cap", () => {
  const files = [
    file("requirements.txt", "@@\n-pydantic==1.10.13\n+pydantic==2.9.2\n"),
    ...Array.from({ length: 30 }, (_, i) => file(`app/m${i}.py`, "@@\n-a\n+b\n")),
  ];
  assert.deepEqual(classify(files, 1, pydantic), { ok: false, reason: "tooBig" });
});
