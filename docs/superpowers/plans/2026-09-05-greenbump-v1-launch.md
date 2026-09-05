# Greenbump v1 Public Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship greenbump as a Marketplace-ready GitHub Action that auto-detects Python major-version bumps in a PR, fixes the code, and pushes the fix onto the PR branch — with a core/wrapper split, structured outcome records, an eval harness, repo CI, and launch docs.

**Architecture:** Three layers under `src/`: `core/` (GitHub-agnostic fix engine: agent, pytest, exec, detect, outcome), `action/` (GitHub Action wrapper: context, delivery, comment, main entry), `eval/` (miner, validator, sandbox, run-eval harness — never bundled). The action bundles to `dist/action.js` via esbuild.

**Tech Stack:** TypeScript (strict, NodeNext, `.ts` import extensions), Node 20 ESM, `node:test` via `tsx --test`, esbuild bundle, `@anthropic-ai/claude-agent-sdk`, `uv` for eval sandboxes.

**Spec:** `docs/superpowers/specs/2026-09-05-greenbump-v1-launch-design.md`

## Global Constraints

- The action must **never fail the customer's build**: every exit path in `src/action/main.ts` calls `process.exit(0)`.
- Silence on failure is a product feature: no push, no comment, no branch unless a verified fix exists.
- Only source files are ever committed (existing test-file and artifact stripping in `core/agent.ts` stays untouched).
- `src/eval/` is never imported from `src/core/` or `src/action/` and never reaches `dist/`.
- Imports use explicit `.ts` extensions (repo convention; `allowImportingTsExtensions` is on).
- Comment density/style: match existing files — sparse, explaining *why*, not *what*.
- A "major bump" = any increase of the leftmost version component (`0.9 → 1.0` counts).
- After changing anything under `src/core/` or `src/action/`, `dist/` must be rebuilt before the final commit of that task (`npm run build`).
- All commands run from the repo root.

---

### Task 1: Restructure `src/` into core / action / eval layers

**Files:**
- Move: `src/agent.ts`, `src/pytest.ts`, `src/exec.ts` → `src/core/`
- Move: `src/action.ts` → `src/action/main.ts`
- Move: `src/mine.ts`, `src/mine-repos.ts`, `src/validate.ts`, `src/sandbox.ts`, `src/github.ts`, `src/filter.ts`, `src/quality.ts`, `src/targets.ts`, `src/types.ts`, `src/filter.test.ts`, `src/quality.test.ts` → `src/eval/`
- Modify: `package.json` (script paths, build entry)
- Modify: `src/action/main.ts` (import paths only)

**Interfaces:**
- Consumes: nothing new.
- Produces: the layout every later task assumes — `src/core/agent.ts` exporting `attemptFix(req: FixRequest): Promise<FixOutcome>`, `src/core/exec.ts` exporting `run(cmd, args, opts): Promise<Run>` and `tail(s, lines)`, `src/core/pytest.ts` exporting `runPytest`, `collectCount`, `TestCounts`, `TestResult`.

- [ ] **Step 1: Move the files with git mv**

```bash
mkdir -p src/core src/action src/eval
git mv src/agent.ts src/pytest.ts src/exec.ts src/core/
git mv src/action.ts src/action/main.ts
git mv src/mine.ts src/mine-repos.ts src/validate.ts src/sandbox.ts \
       src/github.ts src/filter.ts src/quality.ts src/targets.ts \
       src/types.ts src/filter.test.ts src/quality.test.ts src/eval/
```

- [ ] **Step 2: Fix cross-layer imports in `src/action/main.ts`**

Only two imports cross layers. In `src/action/main.ts` change:

```typescript
import { attemptFix } from "./agent.ts";
import { run } from "./exec.ts";
```

to:

```typescript
import { attemptFix } from "../core/agent.ts";
import { run } from "../core/exec.ts";
```

All other files import siblings that moved with them; no other import changes.

- [ ] **Step 3: Update `package.json` scripts**

Replace the `scripts` block with:

```json
"scripts": {
  "test": "tsx --test src/eval/*.test.ts",
  "mine": "tsx src/eval/mine.ts",
  "validate": "tsx src/eval/validate.ts",
  "fix": "tsx src/action/main.ts",
  "typecheck": "tsc --noEmit",
  "build": "esbuild src/action/main.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/action.js --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\""
},
```

- [ ] **Step 4: Verify everything still works**

Run: `npm test && npm run typecheck && npm run build`
Expected: 26 tests pass, no type errors, `dist/action.js` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: split src into core, action, and eval layers

core/ is the GitHub-agnostic fix engine the future hosted App reuses;
action/ is the Actions wrapper; eval/ is the miner and never ships."
```

---

### Task 2: `src/core/detect.ts` — find major bumps in a manifest diff

**Files:**
- Create: `src/core/detect.ts`
- Test: `src/core/detect.test.ts`
- Modify: `package.json` (test glob)

**Interfaces:**
- Consumes: nothing.
- Produces: `detectMajorBumps(diff: string): DetectedBump[]` and `type DetectedBump = { library: string; fromVersion?: string; toVersion?: string; manifest: string }` (from/to always set when produced by detection; optional so the `library:` input override fits the same type). Task 7's `main.ts` calls this with `git diff <baseSha> HEAD -- <manifests>` output.

- [ ] **Step 1: Write the failing tests**

Create `src/core/detect.test.ts`:

```typescript
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
```

- [ ] **Step 2: Update the test glob and run to verify failure**

In `package.json` change the test script to:

```json
"test": "tsx --test src/eval/*.test.ts src/core/*.test.ts",
```

Run: `npm test`
Expected: FAIL — cannot find module `./detect.ts`.

- [ ] **Step 3: Implement `src/core/detect.ts`**

```typescript
/**
 * Find major-version bumps in a unified diff of dependency manifests.
 *
 * Diff-based on purpose: fully parsing every manifest format is a losing game,
 * but a bump always shows up as a removed line carrying the old version and an
 * added line carrying the new one. Lockfiles split name and version across
 * lines, so we also track the surrounding package context lines.
 */

export type DetectedBump = {
  library: string;
  /** Always present when produced by detection; optional so the manual
   *  `library:` input override fits the same shape. */
  fromVersion?: string;
  toVersion?: string;
  manifest: string;
};

const MANIFEST =
  /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile|Pipfile\.lock|setup\.py|setup\.cfg)$/;

/** PEP 503 normalisation so pydantic_settings and pydantic-settings dedupe. */
const norm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Keys that look like dependencies but never are. */
const IGNORE = new Set(["version", "python", "python-version", "python-full-version", "name"]);

const major = (v: string): number | null => {
  const m = v.match(/^v?(\d+)/);
  return m ? Number(m[1]) : null;
};

/** requirements.txt / PEP 621 list entries / Pipfile: name and version together. */
const REQ_LINE =
  /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*(?:\[[^\]]*\])?\s*(?:===|==|>=|~=|\^|>|=)\s*v?(\d+(?:\.\d+)*)/;

/** pyproject/poetry table entry: pydantic = "^1.10" or pydantic = { version = "^1.10" }. */
const TOML_DEP_LINE =
  /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=\s*(?:\{[^}]*?version\s*=\s*)?["'][~^>=<!]*v?(\d+(?:\.\d+)*)/;

/** Pipfile.lock JSON: "pydantic": {..., "version": "==2.9.2"} on one line. */
const JSON_DEP_LINE = /^"([A-Za-z0-9._-]+)":\s*\{.*?"version":\s*"==?v?(\d+(?:\.\d+)*)"/;

/** Lockfile TOML pairs: name = "pydantic" ... version = "1.10.13". */
const LOCK_NAME = /^name\s*=\s*["']([A-Za-z0-9._-]+)["']/;
const LOCK_VERSION = /^version\s*=\s*["']v?(\d+(?:\.\d+)*)["']/;

type Sides = { removed?: string; added?: string; manifest: string; display: string };

export function detectMajorBumps(diff: string): DetectedBump[] {
  const byPkg = new Map<string, Sides>();
  let file = "";
  let inManifest = false;
  /** Package the current lockfile lines belong to, set by name= lines. */
  let lockContext = "";

  const record = (name: string, version: string, side: "removed" | "added") => {
    const key = norm(name);
    if (IGNORE.has(key)) return;
    const entry = byPkg.get(key) ?? { manifest: file, display: key };
    // Keep the most precise version seen on each side: a lockfile's 2.9.2
    // beats a constraint's bare 2.
    const existing = entry[side];
    if (!existing || version.split(".").length > existing.split(".").length) entry[side] = version;
    byPkg.set(key, entry);
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+ (b\/)?/, "").trim();
      inManifest = file !== "/dev/null" && MANIFEST.test(file);
      lockContext = "";
      continue;
    }
    if (raw.startsWith("--- ") || !inManifest) continue;

    const sign = raw[0];
    if (sign !== "+" && sign !== "-" && sign !== " ") continue;
    const line = raw.slice(1).trim();

    // name= lines set lockfile context whether changed or not.
    const name = line.match(LOCK_NAME);
    if (name) {
      lockContext = name[1];
      continue;
    }
    if (sign === " ") continue;

    const side = sign === "-" ? "removed" : "added";
    const lockVer = line.match(LOCK_VERSION);
    if (lockVer && lockContext) {
      record(lockContext, lockVer[1], side);
      continue;
    }
    const m = line.match(JSON_DEP_LINE) ?? line.match(TOML_DEP_LINE) ?? line.match(REQ_LINE);
    if (m) record(m[1], m[2], side);
  }

  const bumps: DetectedBump[] = [];
  for (const entry of byPkg.values()) {
    if (!entry.removed || !entry.added) continue;
    const from = major(entry.removed);
    const to = major(entry.added);
    if (from === null || to === null || to <= from) continue;
    bumps.push({
      library: entry.display,
      fromVersion: entry.removed,
      toVersion: entry.added,
      manifest: entry.manifest,
    });
  }
  return bumps;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (26 existing + 13 new).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/detect.ts src/core/detect.test.ts package.json
git commit -m "feat: detect major-version bumps from a manifest diff"
```

---

### Task 3: `src/core/outcome.ts` — the structured run record

**Files:**
- Create: `src/core/outcome.ts`
- Test: `src/core/outcome.test.ts`

**Interfaces:**
- Consumes: `TestCounts` from `src/core/pytest.ts`, `DetectedBump` from `src/core/detect.ts`.
- Produces (Task 7 and Task 6 rely on these exact names):
  - `type AttemptOutcome = { library: string; fromVersion?: string; toVersion?: string; fixed: boolean; reason: string; costUsd: number; turns: number; testsBefore?: TestCounts; testsAfter?: TestCounts; filesChanged: string[]; durationMs: number }`
  - `type DeliveryOutcome = { mode: "pr-branch" | "fix-branch" | "local" | "none"; branch?: string; pushed: boolean; commented: boolean; note?: string }`
  - `type OutcomeRecord = { schema: 1; repo?: string; pr?: number; startedAt: string; finishedAt: string; detected: DetectedBump[]; attempts: AttemptOutcome[]; delivery: DeliveryOutcome; totalCostUsd: number }`
  - `totalCost(attempts: AttemptOutcome[]): number`
  - `renderSummary(record: OutcomeRecord): string`
  - `writeOutcomeFile(record: OutcomeRecord): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `src/core/outcome.test.ts`:

```typescript
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
        branch: "greenbump/pydantic-x1",
        pushed: true,
        commented: false,
        note: "the PR branch moved while greenbump was running",
      },
      totalCostUsd: 1.25,
    }),
  );
  assert.match(md, /greenbump\/pydantic-x1/);
  assert.match(md, /moved while greenbump was running/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./outcome.ts`.

- [ ] **Step 3: Implement `src/core/outcome.ts`**

```typescript
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedBump } from "./detect.ts";
import type { TestCounts } from "./pytest.ts";

/** One library attempted during a run. */
export type AttemptOutcome = {
  library: string;
  fromVersion?: string;
  toVersion?: string;
  fixed: boolean;
  reason: string;
  costUsd: number;
  turns: number;
  testsBefore?: TestCounts;
  testsAfter?: TestCounts;
  filesChanged: string[];
  durationMs: number;
};

export type DeliveryOutcome = {
  mode: "pr-branch" | "fix-branch" | "local" | "none";
  branch?: string;
  pushed: boolean;
  commented: boolean;
  note?: string;
};

/**
 * The structured record every run emits. This schema is the seam the hosted
 * App will meter and bill on later — extend it additively and bump `schema`.
 */
export type OutcomeRecord = {
  schema: 1;
  repo?: string;
  pr?: number;
  startedAt: string;
  finishedAt: string;
  detected: DetectedBump[];
  attempts: AttemptOutcome[];
  delivery: DeliveryOutcome;
  totalCostUsd: number;
};

export const totalCost = (attempts: AttemptOutcome[]) =>
  Math.round(attempts.reduce((sum, a) => sum + a.costUsd, 0) * 100) / 100;

/** Write the record where CI can pick it up, and expose it as step outputs. */
export async function writeOutcomeFile(record: OutcomeRecord): Promise<string> {
  const path = join(process.env.RUNNER_TEMP || tmpdir(), "greenbump-outcome.json");
  await writeFile(path, JSON.stringify(record, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `outcome-file=${path}\nfixed=${record.attempts.some((a) => a.fixed)}\n`,
    );
  }
  return path;
}

/** Markdown for the step summary — the same numbers on every exit path. */
export function renderSummary(record: OutcomeRecord): string {
  const lines = ["### greenbump"];
  if (!record.attempts.length) {
    lines.push("", "No major-version bumps detected. Nothing to do.");
    return lines.join("\n");
  }

  for (const a of record.attempts) {
    const version =
      a.fromVersion && a.toVersion ? `${a.fromVersion} → ${a.toVersion}` : "major upgrade";
    lines.push("", `**${a.library}** (${version}) — ${a.fixed ? "fixed ✅" : "no fix proposed"}`, "", a.reason);
    if (a.fixed) {
      lines.push(
        "",
        "| | |",
        "|---|---|",
        `| Tests before | ${a.testsBefore?.failed ?? "?"} failed, ${a.testsBefore?.passed ?? "?"} passed |`,
        `| Tests after | ${a.testsAfter?.passed ?? 0} passed |`,
        `| Files changed | ${a.filesChanged.join(", ")} |`,
        `| Cost | $${a.costUsd.toFixed(2)} over ${a.turns} turns |`,
      );
    }
  }

  const d = record.delivery;
  if (d.mode === "pr-branch" && d.pushed) {
    lines.push("", `Fix pushed to this PR's branch (\`${d.branch}\`).`);
  } else if (d.mode === "fix-branch" && d.pushed) {
    lines.push("", `Fix pushed to \`${d.branch}\`${d.note ? ` — ${d.note}` : ""}. Open a PR to review.`);
  } else if (d.mode === "local") {
    lines.push("", `No token available, so the fix stayed on local branch \`${d.branch}\`.`);
  } else if (d.note) {
    lines.push("", d.note);
  }

  lines.push("", `Total cost $${record.totalCostUsd.toFixed(2)}.`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/outcome.ts src/core/outcome.test.ts
git commit -m "feat: structured outcome record and step-summary renderer"
```

---

### Task 4: `src/action/context.ts` — read the PR context

**Files:**
- Create: `src/action/context.ts`
- Test: `src/action/context.test.ts`
- Modify: `package.json` (test glob)

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 5 and 7 rely on these):
  - `type PrContext = { repo: string; prNumber: number; headRef: string; headSha: string; baseSha: string }`
  - `parsePrContext(eventName: string | undefined, repo: string | undefined, payload: unknown): PrContext | null`
  - `loadPrContext(): Promise<PrContext | null>` (reads `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`)

- [ ] **Step 1: Write the failing tests**

Create `src/action/context.test.ts`:

```typescript
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
```

- [ ] **Step 2: Update the test glob and verify failure**

In `package.json`:

```json
"test": "tsx --test src/eval/*.test.ts src/core/*.test.ts src/action/*.test.ts",
```

Run: `npm test`
Expected: FAIL — cannot find module `./context.ts`.

- [ ] **Step 3: Implement `src/action/context.ts`**

```typescript
import { readFile } from "node:fs/promises";

/** Everything delivery needs to know about the PR the run belongs to. */
export type PrContext = {
  repo: string;
  prNumber: number;
  headRef: string;
  headSha: string;
  baseSha: string;
};

type PrPayload = {
  pull_request?: {
    number?: number;
    head?: { ref?: string; sha?: string };
    base?: { sha?: string };
  };
};

export function parsePrContext(
  eventName: string | undefined,
  repo: string | undefined,
  payload: unknown,
): PrContext | null {
  if (eventName !== "pull_request" && eventName !== "pull_request_target") return null;
  if (!repo) return null;
  const pr = (payload as PrPayload).pull_request;
  if (!pr?.number || !pr.head?.ref || !pr.head?.sha || !pr.base?.sha) return null;
  return {
    repo,
    prNumber: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
  };
}

export async function loadPrContext(): Promise<PrContext | null> {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  return parsePrContext(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REPOSITORY, payload);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/action/context.ts src/action/context.test.ts package.json
git commit -m "feat: parse PR context from the workflow event payload"
```

---

### Task 5: `src/action/deliver.ts` — commit, guard, and push

**Files:**
- Create: `src/action/deliver.ts`
- Test: `src/action/deliver.test.ts`

**Interfaces:**
- Consumes: `run` from `../core/exec.ts`, `PrContext` from `./context.ts`.
- Produces (Task 7 relies on these):
  - `type PushPlan = { mode: "pr-branch" | "fix-branch"; branch: string; note?: string }`
  - `choosePushTarget(opts: { pr: PrContext | null; checkoutSha: string; remoteHeadSha: string | null; fallbackBranch: string }): PushPlan`
  - `commitFix(cwd: string, files: string[], message: string): Promise<boolean>`
  - `remoteHead(cwd: string, url: string, branch: string): Promise<string | null>`
  - `push(cwd: string, url: string, branch: string): Promise<{ ok: boolean; stderr: string }>`

- [ ] **Step 1: Write the failing tests for the decision function**

Create `src/action/deliver.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./deliver.ts`.

- [ ] **Step 3: Implement `src/action/deliver.ts`**

```typescript
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
  /** HEAD at the moment the action started, before greenbump committed. */
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
      note: "the PR branch moved while greenbump was running",
    };
  }
  return { mode: "pr-branch", branch: pr.headRef };
}

const git = (cwd: string, args: string[]) => run("git", args, { cwd, timeoutMs: 120_000 });

export async function commitFix(cwd: string, files: string[], message: string): Promise<boolean> {
  await git(cwd, ["config", "user.name", "greenbump"]);
  await git(cwd, ["config", "user.email", "bot@greenbump.dev"]);
  await git(cwd, ["add", "--", ...files]);
  const r = await git(cwd, ["commit", "-m", message]);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/action/deliver.ts src/action/deliver.test.ts
git commit -m "feat: in-place push with head-moved safety latch"
```

---

### Task 6: `src/action/comment.ts` — the PR comment

**Files:**
- Create: `src/action/comment.ts`
- Test: `src/action/comment.test.ts`

**Interfaces:**
- Consumes: `OutcomeRecord` from `../core/outcome.ts`.
- Produces (Task 7 relies on these):
  - `buildCommentBody(record: OutcomeRecord): string | null` — null when nothing was fixed (silence is the brand).
  - `postComment(token: string, repo: string, prNumber: number, body: string): Promise<boolean>` — never throws.

- [ ] **Step 1: Write the failing tests**

Create `src/action/comment.test.ts`:

```typescript
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
        branch: "greenbump/pydantic-x1",
        pushed: true,
        commented: false,
        note: "the PR branch moved while greenbump was running",
      },
      totalCostUsd: 1.25,
    }),
  );
  assert.ok(body);
  assert.match(body, /`greenbump\/pydantic-x1`/);
  assert.match(body, /moved while greenbump was running/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./comment.ts`.

- [ ] **Step 3: Implement `src/action/comment.ts`**

```typescript
import type { OutcomeRecord } from "../core/outcome.ts";

/** One comment per run, and only when something was actually fixed. */
export function buildCommentBody(record: OutcomeRecord): string | null {
  const fixed = record.attempts.filter((a) => a.fixed);
  if (!fixed.length) return null;

  const lines = ["### greenbump fixed this upgrade ✅"];
  for (const a of fixed) {
    const version = a.fromVersion && a.toVersion ? ` ${a.fromVersion} → ${a.toVersion}` : "";
    lines.push(
      "",
      `**${a.library}${version}** — ${a.reason}`,
      "",
      `Files changed: ${a.filesChanged.map((f) => `\`${f}\``).join(", ")}`,
    );
  }

  const d = record.delivery;
  if (d.mode === "pr-branch") {
    lines.push("", "The fix was pushed to this branch — your checks should rerun green.");
  } else if (d.mode === "fix-branch" && d.branch) {
    lines.push("", `The fix was pushed to \`${d.branch}\` (${d.note ?? "in-place push was not possible"}).`);
  }

  lines.push(
    "",
    `_Verified against your existing test suite; no test files were touched. Total cost $${record.totalCostUsd.toFixed(2)}._`,
  );
  return lines.join("\n");
}

/** Best-effort: a failed comment must never fail the run — the fix is already pushed. */
export async function postComment(
  token: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "greenbump",
      },
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/action/comment.ts src/action/comment.test.ts
git commit -m "feat: PR comment for verified fixes"
```

---

### Task 7: Rewrite `src/action/main.ts` and update `action.yml`

**Files:**
- Modify: `src/action/main.ts` (full rewrite below)
- Modify: `action.yml`
- Modify: `dist/action.js` (rebuild)

**Interfaces:**
- Consumes: everything Tasks 2–6 produced: `attemptFix` (`../core/agent.ts`), `detectMajorBumps`/`DetectedBump` (`../core/detect.ts`), `renderSummary`/`totalCost`/`writeOutcomeFile`/`AttemptOutcome`/`DeliveryOutcome`/`OutcomeRecord` (`../core/outcome.ts`), `loadPrContext` (`./context.ts`), `choosePushTarget`/`commitFix`/`remoteHead`/`push` (`./deliver.ts`), `buildCommentBody`/`postComment` (`./comment.ts`), `run` (`../core/exec.ts`).
- Produces: the shipped entry point. No later task imports it.

- [ ] **Step 1: Replace the entire contents of `src/action/main.ts`**

```typescript
import { appendFile } from "node:fs/promises";
import { attemptFix } from "../core/agent.ts";
import { detectMajorBumps, type DetectedBump } from "../core/detect.ts";
import { run } from "../core/exec.ts";
import {
  renderSummary,
  totalCost,
  writeOutcomeFile,
  type AttemptOutcome,
  type DeliveryOutcome,
  type OutcomeRecord,
} from "../core/outcome.ts";
import { buildCommentBody, postComment } from "./comment.ts";
import { loadPrContext } from "./context.ts";
import { choosePushTarget, commitFix, push, remoteHead } from "./deliver.ts";

/**
 * GitHub Action entry point.
 *
 * Runs inside the customer's own CI, where their dependencies are already
 * installed — which is the whole reason this shape was chosen. We never clone
 * their code to our infrastructure and never hold a credential of theirs.
 *
 * It must never fail their build. Every path exits 0.
 */

const input = (name: string, fallback = "") =>
  process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`]?.trim() || fallback;

async function summary(md: string) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) await appendFile(path, md + "\n");
  console.log(md.replace(/[#*`]/g, ""));
}

const cwd = input("working-directory", process.env.GITHUB_WORKSPACE || process.cwd());
const python = input("python", "python");
const maxBudgetUsd = Number(input("max-cost-usd", "3"));
const maxTurns = Number(input("max-turns", "40"));
const token = process.env.GITHUB_TOKEN || input("github-token");
const repo = process.env.GITHUB_REPOSITORY;

const git = (args: string[]) => run("git", args, { cwd, timeoutMs: 120_000 });

const startedAt = new Date().toISOString();
const pr = await loadPrContext();

const MANIFEST_PATHSPECS = [
  "requirements*.txt", "**/requirements*.txt",
  "pyproject.toml", "**/pyproject.toml",
  "poetry.lock", "**/poetry.lock",
  "uv.lock", "**/uv.lock",
  "Pipfile", "Pipfile.lock", "**/Pipfile", "**/Pipfile.lock",
  "setup.py", "setup.cfg",
];

async function detectBumps(): Promise<DetectedBump[]> {
  const override = input("library");
  if (override) {
    return [
      {
        library: override,
        fromVersion: input("from-version") || undefined,
        toVersion: input("to-version") || undefined,
        manifest: "(library input)",
      },
    ];
  }
  if (!pr) return [];
  await git(["fetch", "--quiet", "--depth=1", "origin", pr.baseSha]);
  const diff = await git(["diff", pr.baseSha, "HEAD", "--", ...MANIFEST_PATHSPECS]);
  return detectMajorBumps(diff.stdout);
}

const buildRecord = (
  attempts: AttemptOutcome[],
  detected: DetectedBump[],
  delivery: DeliveryOutcome,
): OutcomeRecord => ({
  schema: 1,
  repo,
  pr: pr?.prNumber,
  startedAt,
  finishedAt: new Date().toISOString(),
  detected,
  attempts,
  delivery,
  totalCostUsd: totalCost(attempts),
});

async function finish(record: OutcomeRecord): Promise<never> {
  await writeOutcomeFile(record).catch((err) => console.warn(`greenbump: outcome file: ${err.message}`));
  await summary(renderSummary(record));
  process.exit(0);
}

const NONE: DeliveryOutcome = { mode: "none", pushed: false, commented: false };

let detected: DetectedBump[] = [];
try {
  detected = await detectBumps();
} catch (err) {
  console.warn(`greenbump: detection failed: ${(err as Error).message}`);
}

if (!detected.length) {
  console.log("greenbump: no major-version bumps detected");
  await finish(buildRecord([], [], NONE));
}

const checkoutSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

/** Untracked files present before we ran, so cleanup can spare them. */
async function untracked(): Promise<Set<string>> {
  const r = await git(["ls-files", "--others", "--exclude-standard"]);
  return new Set(r.stdout.split("\n").filter(Boolean));
}
const baselineUntracked = await untracked();

/** Drop everything a failed attempt left behind before the next one starts. */
async function revertWorkingTree() {
  await git(["checkout", "--", "."]);
  const created = [...(await untracked())].filter((f) => !baselineUntracked.has(f));
  if (created.length) await git(["clean", "-fq", "--", ...created]);
}

const attempts: AttemptOutcome[] = [];
const fixedLibraries: string[] = [];

for (const bump of detected) {
  const spent = totalCost(attempts);
  const remaining = Math.round((maxBudgetUsd - spent) * 100) / 100;
  const base = { library: bump.library, fromVersion: bump.fromVersion, toVersion: bump.toVersion };

  if (remaining < 0.25) {
    attempts.push({
      ...base,
      fixed: false,
      reason: `skipped — $${spent.toFixed(2)} of the $${maxBudgetUsd} budget already spent`,
      costUsd: 0,
      turns: 0,
      filesChanged: [],
      durationMs: 0,
    });
    continue;
  }

  console.log(`greenbump · ${bump.library} · budget $${remaining} · max ${maxTurns} turns`);
  const started = Date.now();
  let committed = false;
  try {
    const out = await attemptFix({
      cwd,
      library: bump.library,
      fromVersion: bump.fromVersion,
      toVersion: bump.toVersion,
      python,
      maxBudgetUsd: remaining,
      maxTurns,
    });
    attempts.push({
      ...base,
      fixed: out.fixed,
      reason: out.reason,
      costUsd: out.costUsd,
      turns: out.turns,
      testsBefore: out.before.counts,
      testsAfter: out.after?.counts,
      filesChanged: out.filesChanged,
      durationMs: Date.now() - started,
    });

    if (out.fixed) {
      // Commit each verified fix immediately so a later failed attempt's
      // cleanup cannot touch it.
      committed = await commitFix(
        cwd,
        out.filesChanged,
        `greenbump: migrate to ${bump.library} ${bump.toVersion ?? "major upgrade"}\n\n` +
          `${out.reason}\n\nVerified: the existing test suite passes and no test files were modified.`,
      );
      if (committed) {
        fixedLibraries.push(bump.library);
      } else {
        attempts[attempts.length - 1] = {
          ...attempts[attempts.length - 1],
          fixed: false,
          reason: "fix verified but git commit failed",
        };
      }
    }
  } catch (err) {
    attempts.push({
      ...base,
      fixed: false,
      reason: `attempt errored: ${(err as Error).message}`,
      costUsd: 0,
      turns: 0,
      filesChanged: [],
      durationMs: Date.now() - started,
    });
  }
  if (!committed) await revertWorkingTree();
}

if (!fixedLibraries.length) {
  await finish(buildRecord(attempts, detected, NONE));
}

const fallbackBranch = input(
  "branch",
  `greenbump/${fixedLibraries.join("-")}-${Date.now().toString(36)}`,
);

if (!token || !repo) {
  await git(["branch", fallbackBranch]);
  await finish(
    buildRecord(attempts, detected, {
      mode: "local",
      branch: fallbackBranch,
      pushed: false,
      commented: false,
      note: "no token available",
    }),
  );
}

const url = `https://x-access-token:${token}@github.com/${repo}.git`;
const plan = choosePushTarget({
  pr,
  checkoutSha,
  remoteHeadSha: pr ? await remoteHead(cwd, url, pr.headRef) : null,
  fallbackBranch,
});

const pushed = await push(cwd, url, plan.branch);
const delivery: DeliveryOutcome = {
  mode: plan.mode,
  branch: plan.branch,
  pushed: pushed.ok,
  commented: false,
  note: pushed.ok ? plan.note : `push failed: ${pushed.stderr.slice(-300)}`,
};

if (pushed.ok && pr && token) {
  const body = buildCommentBody(buildRecord(attempts, detected, delivery));
  if (body) delivery.commented = await postComment(token, pr.repo, pr.prNumber, body);
}

await finish(buildRecord(attempts, detected, delivery));
```

- [ ] **Step 2: Update `action.yml`**

Replace the `library` input block and add outputs. The `inputs:` section becomes:

```yaml
inputs:
  library:
    description: >
      Override auto-detection and fix this package regardless of the PR diff.
      By default greenbump reads the PR's manifest changes and finds
      major-version bumps itself.
    required: false
  from-version:
    description: Version being upgraded from (only with `library`; improves accuracy)
    required: false
  to-version:
    description: Version being upgraded to (only with `library`; improves accuracy)
    required: false
  python:
    description: Interpreter that has the project's dependencies installed
    required: false
    default: python
  working-directory:
    description: Directory to run in
    required: false
    default: ${{ github.workspace }}
  max-cost-usd:
    description: Hard ceiling on spend for this run, shared across all detected bumps. The run is abandoned rather than exceeding it.
    required: false
    default: "3"
  max-turns:
    description: Maximum agent turns per attempt before giving up
    required: false
    default: "40"
  branch:
    description: Fallback branch for the fix when pushing to the PR branch is not possible. Defaults to a generated name.
    required: false
  github-token:
    description: Token used to push the fix and comment on the PR. Needs contents:write and pull-requests:write.
    required: false
    default: ${{ github.token }}

outputs:
  outcome-file:
    description: Path to a JSON record of everything greenbump did this run.
  fixed:
    description: '"true" when a verified fix was committed and delivered.'
```

Leave `name`, `description`, `author`, `branding`, and `runs` unchanged.

- [ ] **Step 3: Verify and rebuild**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass; `dist/action.js` rebuilt.

- [ ] **Step 4: Local smoke test of the no-op path**

Run: `INPUT_MAX_COST_USD=0 node dist/action.js; echo "exit=$?"`
Expected: prints `greenbump: no major-version bumps detected` (no PR context, no library input) and `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add src/action/main.ts action.yml dist/action.js
git commit -m "feat: auto-detect bumps and fix the PR in place

Detection replaces the required library input; verified fixes are
committed per-library and pushed onto the PR head branch when it is
safe, falling back to a fix branch when the head moved or the checkout
is a merge ref. Every run writes a structured outcome record."
```

---

### Task 8: Sandbox `prepareCase` + `pytestArgs` passthrough

**Files:**
- Modify: `src/eval/sandbox.ts` (extract `prepareCase` from `probeCase`)
- Modify: `src/core/agent.ts` (add `pytestArgs` to `FixRequest`)
- Modify: `src/core/pytest.ts` (`collectCount` honors `opts.args`)
- Modify: `dist/action.js` (rebuild — core changed)

**Interfaces:**
- Consumes: existing sandbox internals (`checkout`, `hasTests`, `detectPython`, `detectInstaller`, `runTests`).
- Produces (Task 9 relies on these):
  - `type PreparedCase = { dir: string; python: string; pythonVersion: string; installer: string }` (`python` is the venv interpreter path)
  - `prepareCase(repo: string, sha: string): Promise<{ ok: true; prepared: PreparedCase } | { ok: false; stage: CaseProbe["stage"]; reason: string }>` — on failure the temp dir is already deleted; on success the **caller owns the dir** and must `rm` it.
  - `FixRequest` gains optional `pytestArgs?: string[]`, forwarded to both `runPytest` and `collectCount`.

- [ ] **Step 1: Add `prepareCase` to `src/eval/sandbox.ts`**

Insert after the `runTests` function:

```typescript
export type PreparedCase = {
  dir: string;
  /** venv interpreter path — hand this to pytest or the fix agent. */
  python: string;
  pythonVersion: string;
  installer: string;
};

/**
 * Clone one commit and build its environment, keeping the workspace alive.
 * The caller owns `dir` on success and must delete it; failures clean up
 * after themselves.
 */
export async function prepareCase(
  repo: string,
  sha: string,
): Promise<{ ok: true; prepared: PreparedCase } | { ok: false; stage: CaseProbe["stage"]; reason: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bcm-"));
  const fail = async (stage: CaseProbe["stage"], reason: string) => {
    await rm(dir, { recursive: true, force: true });
    return { ok: false as const, stage, reason };
  };

  const co = await checkout(repo, sha, dir);
  if (!co.ok) return fail("clone", co.reason ?? "clone failed");
  if (!(await hasTests(dir))) return fail("detect", "no test files");

  const python = await detectPython(dir);
  const installer = await detectInstaller(dir);
  if (!installer) return fail("detect", "no dependency manifest");

  const venv = join(dir, ".venv");
  let r = await run("uv", ["venv", "--python", python, venv], { cwd: dir, timeoutMs: 180_000 });
  if (!r.ok) return fail("install", `venv ${python}: ${tail(r.stderr, 2)}`);

  for (const [i, args] of installer.steps.entries()) {
    r = await run("uv", args, { cwd: dir, timeoutMs: INSTALL_MS, env: venvEnv(dir) });
    // Only the first step is load-bearing; extras groups are best-effort.
    if (!r.ok && i === 0) return fail("install", r.timedOut ? "install timed out" : tail(r.stderr, 3));
  }

  // pytest itself is often only a dev-extra; install it explicitly.
  await run("uv", ["pip", "install", "pytest", "pytest-asyncio", "anyio"], {
    cwd: dir,
    timeoutMs: 180_000,
    env: venvEnv(dir),
  });

  return {
    ok: true,
    prepared: { dir, python: join(venv, "bin", "python"), pythonVersion: python, installer: installer.label },
  };
}

/** Environment that points uv at the case's venv. */
export const venvEnv = (dir: string) => ({
  VIRTUAL_ENV: join(dir, ".venv"),
  UV_PROJECT_ENVIRONMENT: join(dir, ".venv"),
});
```

- [ ] **Step 2: Rewrite `probeCase` to use it**

Replace the body of `probeCase` (keep its doc comment and signature):

```typescript
export async function probeCase(repo: string, sha: string): Promise<CaseProbe> {
  const started = Date.now();
  const prep = await prepareCase(repo, sha);
  if (!prep.ok) {
    return { stage: prep.stage, ok: false, reason: prep.reason, ms: Date.now() - started };
  }
  const { dir, pythonVersion, installer } = prep.prepared;
  try {
    const test = await runTests(dir, join(dir, ".venv"));
    return {
      stage: test.ran ? "done" : "test",
      ok: test.ran && test.passed,
      reason: test.ran ? (test.passed ? undefined : "suite red at parent") : "collected no tests",
      python: pythonVersion,
      installer,
      test,
      ms: Date.now() - started,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

Note: failure probes no longer carry `python`/`installer` detail — acceptable; `validate.ts` only logs `stage` and `reason` for failures.

- [ ] **Step 3: Add `pytestArgs` to the fix engine**

In `src/core/agent.ts`, add to `FixRequest` after `maxTurns: number;`:

```typescript
  /** Extra pytest args, e.g. eval sandboxes blank warning filters. */
  pytestArgs?: string[];
```

and change the first line of `attemptFix` from:

```typescript
  const testOpts = { cwd: req.cwd, python: req.python };
```

to:

```typescript
  const testOpts = { cwd: req.cwd, python: req.python, args: req.pytestArgs };
```

In `src/core/pytest.ts`, change the `collectCount` command array from:

```typescript
    ["-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
```

to:

```typescript
    ["-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", ...(opts.args ?? [])],
```

- [ ] **Step 4: Verify and rebuild**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass; dist rebuilt (core changed).

- [ ] **Step 5: Commit**

```bash
git add src/eval/sandbox.ts src/core/agent.ts src/core/pytest.ts dist/action.js
git commit -m "feat: reusable case preparation and pytest arg passthrough for evals"
```

---

### Task 9: `src/eval/run-eval.ts` — score the engine on the corpus

**Files:**
- Create: `src/eval/run-eval.ts`
- Modify: `package.json` (add `eval` script)

**Interfaces:**
- Consumes: `prepareCase`, `venvEnv` from `./sandbox.ts`; `attemptFix` from `../core/agent.ts`; `TARGETS` from `./targets.ts`; `CorpusEntry` from `./types.ts`; `run`, `tail` from `../core/exec.ts`. Reads `corpus/<lib>.runnable.jsonl` (produced by `npm run validate`).
- Produces: `docs/evals/<lib>-results.json` and `docs/evals/<lib>-v<from>-v<to>.md`. No later task imports it.

- [ ] **Step 1: Add the script to `package.json`**

```json
"eval": "tsx src/eval/run-eval.ts",
```

- [ ] **Step 2: Implement `src/eval/run-eval.ts`**

```typescript
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { attemptFix } from "../core/agent.ts";
import { run, tail } from "../core/exec.ts";
import { prepareCase, venvEnv } from "./sandbox.ts";
import { TARGETS } from "./targets.ts";
import type { CorpusEntry } from "./types.ts";

/**
 * Score the fix engine against mined, validated migration cases.
 *
 * For each case: check out the pre-migration tree, install its deps, bump the
 * target library across the major boundary, then let the engine try to make
 * the suite green. Serial on purpose — every attempt is real API spend.
 *
 * Usage: ANTHROPIC_API_KEY=... npm run eval pydantic -- --n=5 --budget=3
 */

const lib = process.argv[2] ?? "pydantic";
const limit = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? Infinity);
const budget = Number(process.argv.find((a) => a.startsWith("--budget="))?.slice(9) ?? 3);

const target = TARGETS[lib];
if (!target) {
  console.error(`unknown target "${lib}" — known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required — eval attempts are real agent runs");
  process.exit(1);
}

const raw = await readFile(`corpus/${lib}.runnable.jsonl`, "utf8");
const cases = raw
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CorpusEntry)
  .slice(0, limit);

type CaseResult = {
  id: string;
  repo: string;
  sha: string;
  result: "fixed" | "not-fixed" | "skipped";
  reason: string;
  costUsd: number;
  turns: number;
  ms: number;
};

/** Outcomes that say the case could not test the engine, not that it failed. */
const SKIP_REASONS = ["suite already green", "no tests collected"];

const results: CaseResult[] = [];

for (const [i, c] of cases.entries()) {
  console.log(`\n[${i + 1}/${cases.length}] ${c.repo} @ ${c.parentSha.slice(0, 8)}`);
  const started = Date.now();
  const record = (result: CaseResult["result"], reason: string, costUsd = 0, turns = 0) => {
    console.log(`  ${result}: ${reason}${costUsd ? ` ($${costUsd.toFixed(2)})` : ""}`);
    results.push({ id: c.id, repo: c.repo, sha: c.parentSha, result, reason, costUsd, turns, ms: Date.now() - started });
  };

  const prep = await prepareCase(c.repo, c.parentSha);
  if (!prep.ok) {
    record("skipped", `${prep.stage}: ${prep.reason}`);
    continue;
  }
  const { dir, python } = prep.prepared;

  try {
    const spec = c.version
      ? `${lib}==${c.version.to}`
      : `${lib}>=${target.toMajor},<${target.toMajor + 1}`;
    const bump = await run("uv", ["pip", "install", spec], {
      cwd: dir,
      timeoutMs: 300_000,
      env: venvEnv(dir),
    });
    if (!bump.ok) {
      record("skipped", `bump install failed: ${tail(bump.stderr, 3)}`);
      continue;
    }

    const out = await attemptFix({
      cwd: dir,
      library: lib,
      fromVersion: c.version?.from,
      toVersion: c.version?.to,
      python,
      maxBudgetUsd: budget,
      maxTurns: 40,
      // Same rationale as the validator: we measure whether code works, not
      // whether a 2024 warning policy survives 2026 transitive deps.
      pytestArgs: ["--override-ini=filterwarnings="],
    });
    const kind = out.fixed
      ? "fixed"
      : SKIP_REASONS.some((s) => out.reason.startsWith(s))
        ? "skipped"
        : "not-fixed";
    record(kind, out.reason, out.costUsd, out.turns);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const attempted = results.filter((r) => r.result !== "skipped");
const fixed = attempted.filter((r) => r.result === "fixed");
const costs = attempted.map((r) => r.costUsd).sort((a, b) => a - b);
const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
const rate = attempted.length ? Math.round((100 * fixed.length) / attempted.length) : 0;

await mkdir("docs/evals", { recursive: true });
await writeFile(
  `docs/evals/${lib}-results.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), budget, results }, null, 2) + "\n",
);

const rows = results.map(
  (r) =>
    `| [${r.repo}](https://github.com/${r.repo}/commit/${r.sha}) | ${r.result} | ${r.reason.slice(0, 80)} | $${r.costUsd.toFixed(2)} | ${(r.ms / 60_000).toFixed(1)}m |`,
);
const md = [
  `# greenbump eval — ${lib} v${target.fromMajor} → v${target.toMajor}`,
  "",
  `Generated ${new Date().toISOString().slice(0, 10)} · budget $${budget}/case · ${cases.length} mined cases`,
  "",
  `**Fixed ${fixed.length} of ${attempted.length} attempted (${rate}%)** · median cost $${median.toFixed(2)} per attempt · ${results.length - attempted.length} skipped (bump did not break the suite, or the environment failed)`,
  "",
  "| Case | Result | Reason | Cost | Time |",
  "|---|---|---|---|---|",
  ...rows,
  "",
].join("\n");
await writeFile(`docs/evals/${lib}-v${target.fromMajor}-v${target.toMajor}.md`, md);

console.log(`\nfixed ${fixed.length}/${attempted.length} (${rate}%) · wrote docs/evals/${lib}-v${target.fromMajor}-v${target.toMajor}.md`);
```

- [ ] **Step 3: Verify it compiles and fails fast without a key**

Run: `npm run typecheck && (unset ANTHROPIC_API_KEY; npm run eval pydantic 2>&1 | tail -1)`
Expected: typecheck clean; the eval prints `ANTHROPIC_API_KEY is required — eval attempts are real agent runs`.

- [ ] **Step 4: Commit**

```bash
git add src/eval/run-eval.ts package.json
git commit -m "feat: eval harness that scores the fix engine on the mined corpus"
```

---

### Task 10: Repo CI with dist drift check

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm test`, `npm run typecheck`, `npm run build`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - run: npm run build
      - name: dist must match src
        run: git diff --exit-code -- dist
```

- [ ] **Step 2: Verify the drift check logic locally**

Run: `npm run build && git diff --exit-code -- dist; echo "drift-check=$?"`
Expected: `drift-check=0` (dist committed in Tasks 7/8 matches src).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: tests, typecheck, and dist drift check"
```

---

### Task 11: README and updated example workflow

**Files:**
- Create: `README.md`
- Modify: `examples/workflow.yml`

**Interfaces:**
- Consumes: the behavior shipped in Task 7 (auto-detection, in-place push, permissions).
- Produces: launch-facing docs. The eval table links `docs/evals/pydantic-v1-v2.md`, produced by the Task 12 eval run — insert real numbers then.

- [ ] **Step 1: Replace `examples/workflow.yml`**

```yaml
# What a customer adds to their repo. This is the whole onboarding.
name: greenbump

on:
  pull_request:
    paths:
      - "requirements*.txt"
      - "**/requirements*.txt"
      - pyproject.toml
      - "**/pyproject.toml"
      - poetry.lock
      - "**/poetry.lock"
      - uv.lock
      - "**/uv.lock"
      - Pipfile.lock

permissions:
  contents: write
  pull-requests: write

jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Check out the PR branch itself (not the merge ref) so greenbump
          # can push the verified fix onto this PR.
          ref: ${{ github.head_ref }}

      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }

      # Your normal install step — greenbump reuses the environment your CI
      # already knows how to build.
      - run: pip install -r requirements.txt pytest

      - uses: Shridhar2104/greenbump@v1
        env:
          # For Dependabot PRs this must also be added under
          # Settings → Secrets → Dependabot.
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- [ ] **Step 2: Write `README.md`**

```markdown
# greenbump

**When a dependency's major-version bump breaks your build, greenbump fixes
your code — in your own CI, verified against your own tests.**

Dependabot opens a PR bumping `pydantic` to v2. Your suite goes red. A few
minutes later a commit lands on that same PR migrating your code to the new
API, and the checks rerun green. That's the whole product.

## How it works

1. A PR changes a Python manifest (`requirements.txt`, `pyproject.toml`,
   a lockfile). greenbump diffs it and finds packages whose **major** version
   increased.
2. It runs your test suite. Already green? It stops — nothing to fix.
3. If the bump broke the suite, an agent (Claude) edits your **source code**
   under a hard cost ceiling, rerunning your tests until they pass.
4. Only when the suite is genuinely green — and no test file was touched —
   does it commit and push the fix onto the PR branch and leave one comment.

## What it will never do

- **Fail your build.** Every path exits 0. greenbump is an extra chance, not a
  gate.
- **Ship an unverified fix.** No green suite, no push, no comment. Silence.
- **Touch your tests.** Fixes that edit, skip, or weaken tests are discarded.
  It also verifies the number of collected tests did not drop.
- **Exceed the budget.** `max-cost-usd` (default $3) is a hard ceiling.
- **Send your code anywhere.** It runs in your CI with your API key. There is
  no greenbump server.

## Setup

Add `.github/workflows/greenbump.yml` — see [examples/workflow.yml](examples/workflow.yml):

- `permissions: contents: write` + `pull-requests: write`
- `actions/checkout` with `ref: ${{ github.head_ref }}` (so the fix can land
  on the PR; without it greenbump falls back to pushing a separate branch)
- your usual dependency install step
- the action, with `ANTHROPIC_API_KEY` in secrets

**Dependabot note:** workflows triggered by Dependabot PRs read secrets from
*Dependabot secrets*, not Actions secrets. Add `ANTHROPIC_API_KEY` under
**Settings → Secrets and variables → Dependabot** too.

## Results

Measured on real-world open-source migrations mined from GitHub (each case is
a repo whose suite was green before the bump and red after):

<!-- EVAL_TABLE: filled from docs/evals/pydantic-v1-v2.md after the eval run -->
See [docs/evals/](docs/evals/) for per-case results.

## Configuration

| Input | Default | What it does |
|---|---|---|
| `library` | *(auto-detect)* | Override detection and fix this package |
| `from-version` / `to-version` | *(from diff)* | Versions, when overriding |
| `python` | `python` | Interpreter with your deps installed |
| `working-directory` | workspace | Directory to run in |
| `max-cost-usd` | `3` | Hard spend ceiling for the whole run |
| `max-turns` | `40` | Max agent turns per attempt |
| `branch` | generated | Fallback branch when in-place push isn't safe |
| `github-token` | `github.token` | Needs `contents:write`, `pull-requests:write` |

Outputs: `fixed` (`"true"`/`"false"`) and `outcome-file` (path to a JSON
record of the run: what was detected, attempted, spent, and delivered).

## FAQ

**Which upgrades does it handle?** Any Python package whose major version
bumped. Python-only for now.

**What if several majors bump in one PR?** Each is attempted sequentially
sharing one budget; each verified fix is its own commit.

**What does it cost?** Your Anthropic API usage, capped by `max-cost-usd`.
Failed attempts still consume what they used before giving up.

**Why did it stay silent on my PR?** It couldn't produce a verified fix
within budget. The step summary in the workflow run has the full story.
```

- [ ] **Step 3: Commit**

```bash
git add README.md examples/workflow.yml
git commit -m "docs: README and auto-detect example workflow"
```

---

### Task 12: Launch operations (user-gated: real spend and account actions)

**Files:**
- Modify: `README.md` (insert real eval numbers)
- Create (external): demo repo, `v1` tag, Marketplace listing

These steps need the user's GitHub account, Anthropic key, and $50–150 of eval spend. Execute the commands; pause for the user where marked **[USER]**.

- [ ] **Step 1: Build and validate the corpus** (needs `GITHUB_TOKEN` with public-repo read; no AI spend)

```bash
GITHUB_TOKEN=<token> npm run mine pydantic
npm run validate pydantic
wc -l corpus/pydantic.runnable.jsonl
```

Expected: a non-trivial number of runnable cases (target ≥ 15; if fewer, widen `repoQueries` in `src/eval/targets.ts` and re-mine).

- [ ] **Step 2: Smoke the eval on two cases** (small spend, ~$6 max)

```bash
ANTHROPIC_API_KEY=<key> npm run eval pydantic -- --n=2
```

Expected: `docs/evals/pydantic-v1-v2.md` written with 2 rows and sane costs.

- [ ] **Step 3: [USER] Approve the full eval run, then run it**

```bash
ANTHROPIC_API_KEY=<key> npm run eval pydantic
git add docs/evals
git commit -m "docs: pydantic v1→v2 eval results"
```

- [ ] **Step 4: Insert the numbers into README and commit**

Replace the `<!-- EVAL_TABLE ... -->` comment in `README.md` with the headline line from `docs/evals/pydantic-v1-v2.md` (the "**Fixed X of N attempted (R%)** · median cost $Y" line) plus the link. Commit:

```bash
git add README.md
git commit -m "docs: publish eval numbers in README"
```

- [ ] **Step 5: [USER] Create the demo repo** — a small pydantic v1 app (e.g. three models using `@validator`, `.dict()`, `class Config`, ~10 tests), `requirements.txt` pinning `pydantic==1.10.13`, the greenbump workflow from `examples/workflow.yml`, and Dependabot config (`.github/dependabot.yml`, pip ecosystem, daily). Open (or let Dependabot open) the pydantic 2.x bump PR, let greenbump fix it, and keep the PR/commit public. Link it from the README's "How it works" section.

- [ ] **Step 6: [USER] Tag v1 and list on the Marketplace**

```bash
git tag -a v1 -m "greenbump v1"
git push origin v1
```

Then draft a GitHub Release from the tag with "Publish this Action to the GitHub Marketplace" checked (Marketplace listing is UI-only).

---

## Self-review notes

- Spec §2 core/wrapper/eval split → Task 1; detect → Task 2; outcome → Task 3; §4 delivery + guard → Tasks 5, 7; PR comment → Tasks 6, 7; §3 auto-detect + multi-bump shared budget + override → Tasks 2, 7; §5 eval harness + demo repo → Tasks 8, 9, 12; §6 README/CI/examples/tag → Tasks 10, 11, 12; §7 invariants table → Task 7 (`finish()` + exit-0 paths); §8 unit tests → Tasks 2–6.
- `DetectedBump.fromVersion/toVersion` deliberately optional so the `library:` input override shares the type (spec's detection always fills them).
- The Dependabot-secrets caveat lives in the example workflow comment and README (spec §4).
