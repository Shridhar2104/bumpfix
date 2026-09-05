import { readFile, writeFile } from "node:fs/promises";
import { freeDiskGB, probeCase, pruneCache, type CaseProbe } from "./sandbox.ts";
import type { CorpusEntry } from "./types.ts";

/** Below this the workspaces stop fitting and installs fail confusingly. */
const MIN_FREE_GB = 3;
/** Each probe holds a full venv on disk, so keep few in flight. */
const CONCURRENCY = 3;

type Validated = CorpusEntry & { probe: CaseProbe };

async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const lib = process.argv[2] ?? "pydantic";
const limit = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? Infinity);

const free = await freeDiskGB();
console.log(`free disk ${free.toFixed(1)} GB · concurrency ${CONCURRENCY}`);
if (free < MIN_FREE_GB) {
  console.error(`\nNeed at least ${MIN_FREE_GB} GB free to build environments. Free some space and re-run.`);
  process.exit(1);
}

const raw = await readFile(`corpus/${lib}.jsonl`, "utf8");
const corpus: CorpusEntry[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cases = corpus.slice(0, limit);

console.log(`probing ${cases.length} of ${corpus.length} ${lib} cases at their parent commit\n`);

let completed = 0;
let halted = false;

const results = await pool(cases, CONCURRENCY, async (entry) => {
  // uv's wheel cache grows unbounded across a batch — several GB over a few
  // dozen repos — so reclaim it rather than dying halfway through a long run.
  if (!halted && (await freeDiskGB()) < MIN_FREE_GB) {
    await pruneCache();
    if ((await freeDiskGB()) < MIN_FREE_GB) {
      halted = true;
      console.warn(`\nOut of disk after ${completed} cases — stopping early.`);
    }
  }
  if (halted) {
    return { ...entry, probe: { stage: "detect", ok: false, reason: "skipped, low disk", ms: 0 } } as Validated;
  }

  const probe = await probeCase(entry.repo, entry.parentSha);
  completed++;
  const mark = probe.ok ? "✓" : "·";
  const detail = probe.ok
    ? `${probe.test!.counts.passed} passed in ${(probe.test!.ms / 1000).toFixed(0)}s`
    : `${probe.stage}: ${probe.reason ?? "failed"}`.slice(0, 72);
  console.log(
    `${mark} [${String(completed).padStart(2)}/${cases.length}] ${entry.repo.padEnd(46).slice(0, 46)} ${detail}`,
  );
  return { ...entry, probe } as Validated;
});

const runnable = results.filter((r) => r.probe.ok);

// Record why each probe failed. Without this a systematic harness bug looks
// exactly like a bad corpus, and diagnosing it means re-running by hand.
const failures = results.filter((r) => !r.probe.ok);
if (failures.length) {
  const log = failures
    .map((r) =>
      [
        `### ${r.repo} @ ${r.parentSha.slice(0, 10)}`,
        `stage      ${r.probe.stage}`,
        `reason     ${r.probe.reason ?? "-"}`,
        `python     ${r.probe.python ?? "-"}`,
        `installer  ${r.probe.installer ?? "-"}`,
        r.probe.test ? `counts     ${JSON.stringify(r.probe.test.counts)}` : "",
        r.probe.test?.output ? `\n${r.probe.test.output}` : "",
      ].filter(Boolean).join("\n"),
    )
    .join("\n\n" + "─".repeat(70) + "\n\n");
  await writeFile(`corpus/${lib}.probe-failures.log`, log + "\n");
}
const out = `corpus/${lib}.runnable.jsonl`;
await writeFile(out, runnable.map((e) => JSON.stringify(e)).join("\n") + (runnable.length ? "\n" : ""));

const byStage = results.reduce<Record<string, number>>((a, r) => {
  if (r.probe.ok) return a;
  a[r.probe.stage] = (a[r.probe.stage] ?? 0) + 1;
  return a;
}, {});

const markerCount = (list: Validated[]) =>
  list.flatMap((e) => e.markers).reduce<Record<string, number>>((a, m) => ((a[m] = (a[m] ?? 0) + 1), a), {});

console.log(`\n${"─".repeat(56)}`);
console.log(`runnable     ${runnable.length}/${cases.length} → ${out}`);
console.log(
  `failed at    ${Object.entries(byStage).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"}`,
);
console.log(
  `markers      ${Object.entries(markerCount(runnable)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}`,
);
console.log(`wall time    ${(results.reduce((n, r) => n + r.probe.ms, 0) / 1000 / 60).toFixed(1)} min of probe work`);
if (failures.length) console.log(`diagnostics  corpus/${lib}.probe-failures.log`);
