import { mkdir, writeFile } from "node:fs/promises";
import { GitHub } from "./github.ts";
import { classify, type Rejection } from "./filter.ts";
import { TARGETS } from "./targets.ts";
import type { CorpusEntry, Target } from "./types.ts";

/** How many entries any single repo may contribute — corpus diversity matters. */
const MAX_PER_REPO = 3;

async function mine(gh: GitHub, target: Target, want: number) {
  const entries: CorpusEntry[] = [];
  const perRepo = new Map<string, number>();
  const seen = new Set<string>();
  /** Forks and renamed mirrors reappear under a different repo with the same
   *  sha; counting them twice would silently inflate any eval score. */
  const seenSha = new Set<string>();
  const rejected: Record<Rejection | "repoCap", number> = {
    merge: 0, noCode: 0, tooBig: 0, noSignal: 0, repoCap: 0,
  };
  let scanned = 0;

  outer: for (const query of target.queries) {
    console.log(`\nsearch: "${query}"`);
    let hits;
    try {
      hits = await gh.searchCommits(query);
    } catch (err) {
      console.warn(`  search failed: ${(err as Error).message}`);
      continue;
    }
    console.log(`  ${hits.length} candidate commits`);

    for (const hit of hits) {
      const repo = hit.repository?.full_name;
      if (!repo) continue;
      const key = `${repo}@${hit.sha}`;
      if (seen.has(key) || seenSha.has(hit.sha)) continue;
      seen.add(key);

      if ((perRepo.get(repo) ?? 0) >= MAX_PER_REPO) {
        rejected.repoCap++;
        continue;
      }

      if (gh.coreRemaining !== null && gh.coreRemaining < 5) {
        console.warn(`\n  core budget exhausted — stopping with ${entries.length} entries.`);
        break outer;
      }

      scanned++;
      let detail;
      try {
        detail = await gh.getCommit(repo, hit.sha);
      } catch {
        continue;
      }

      const verdict = classify(detail.files ?? [], detail.parents.length, target);
      if (!verdict.ok) {
        rejected[verdict.reason]++;
        continue;
      }

      const { version, evidence, markers, manifestFiles, codeFiles } = verdict;
      const stats = {
        codeFiles: codeFiles.length,
        additions: codeFiles.reduce((n, f) => n + f.additions, 0),
        deletions: codeFiles.reduce((n, f) => n + f.deletions, 0),
      };

      entries.push({
        id: `${repo.replace("/", "__")}@${detail.sha.slice(0, 10)}`,
        library: target.name,
        repo,
        sha: detail.sha,
        parentSha: detail.parents[0].sha,
        url: detail.html_url,
        message: detail.commit.message.split("\n")[0].slice(0, 200),
        committedAt: detail.commit.committer.date,
        version,
        evidence,
        markers,
        manifestFiles,
        codeFiles,
        stats,
      });
      perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
      seenSha.add(detail.sha);

      console.log(
        `  ✓ ${repo}@${detail.sha.slice(0, 7)} ` +
          (version ? `${version.from}→${version.to}` : `[${evidence}]`) +
          ` · ${stats.codeFiles} files (+${stats.additions}/-${stats.deletions})` +
          (markers.length ? ` · ${markers.join(",")}` : ""),
      );

      if (entries.length >= want) break outer;
    }

    await new Promise((r) => setTimeout(r, gh.searchDelayMs));
  }

  return { entries, scanned, rejected };
}

const args = process.argv.slice(2);
const libArg = args.find((a) => !a.startsWith("-")) ?? "pydantic";
const want = Number(args.find((a) => a.startsWith("--n="))?.slice(4) ?? 50);

const target = TARGETS[libArg];
if (!target) {
  console.error(`Unknown library "${libArg}". Known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const gh = new GitHub();

// Preflight. Each candidate costs one core call, so without a token this ends
// after 60 and stalls for the rest of the hour.
const limits = await gh.rateLimit();
console.log(
  `core ${limits.core.remaining}/${limits.core.limit} · ` +
    `search ${limits.search.remaining}/${limits.search.limit}` +
    (gh.authed ? " (authenticated)" : " (anonymous)"),
);
if (limits.core.remaining < 20) {
  const mins = Math.ceil((limits.core.reset * 1000 - Date.now()) / 60000);
  console.error(
    `\nOnly ${limits.core.remaining} core calls left; resets in ${mins} min.\n` +
      (gh.authed
        ? "Wait for the reset, then re-run."
        : "Set GITHUB_TOKEN to raise the limit from 60/hr to 5000/hr:\n" +
          "  export GITHUB_TOKEN=$(gh auth token)   # or a fine-grained PAT, public-repo read is enough"),
  );
  process.exit(1);
}

console.log(`\nMining ${target.name} v${target.fromMajor} → v${target.toMajor}, target ${want} cases`);

const { entries, scanned, rejected } = await mine(gh, target, want);

await mkdir("corpus", { recursive: true });
const out = `corpus/${target.name}.jsonl`;
await writeFile(out, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

const repos = new Set(entries.map((e) => e.repo)).size;
const sizes = entries.map((e) => e.stats.codeFiles).sort((a, b) => a - b);
const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;

console.log(`\n${"─".repeat(56)}`);
console.log(`corpus       ${entries.length} entries across ${repos} repos → ${out}`);
console.log(`scanned      ${scanned} commits`);
console.log(
  `rejected     ${rejected.noSignal} no signal · ${rejected.noCode} no code · ` +
    `${rejected.tooBig} too large · ${rejected.merge} merges · ${rejected.repoCap} repo cap`,
);
console.log(`median size  ${median} files changed`);

const byEvidence = entries.reduce<Record<string, number>>((a, e) => ((a[e.evidence] = (a[e.evidence] ?? 0) + 1), a), {});
console.log(`evidence     ${Object.entries(byEvidence).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"}`);

const byMarker = entries.flatMap((e) => e.markers).reduce<Record<string, number>>((a, m) => ((a[m] = (a[m] ?? 0) + 1), a), {});
const ranked = Object.entries(byMarker).sort((a, b) => b[1] - a[1]);
console.log(`markers      ${ranked.map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}`);
