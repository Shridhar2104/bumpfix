import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./exec.ts";
import { parseCollectedNodes } from "./pytest.ts";

test("a command that cannot spawn reports code null, not a fake exit 1", async () => {
  const r = await run("definitely-not-a-real-command-xyz", ["--version"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.match(r.stderr, /ENOENT/);
});

test("a real command that exits non-zero keeps its numeric code", async () => {
  const r = await run("node", ["-e", "process.exit(3)"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
});

test("collected node ids are the :: lines of collect-only output", () => {
  const out = [
    "tests/test_a.py::test_one",
    "tests/test_a.py::test_two[param-1]",
    "",
    "45/50 tests collected (5 deselected) in 0.12s",
  ].join("\n");
  assert.deepEqual(parseCollectedNodes(out), [
    "tests/test_a.py::test_one",
    "tests/test_a.py::test_two[param-1]",
  ]);
});
