import { GitHub, type RepoHit } from "./github.ts";
import { classify, type Rejection } from "./filter.ts";
import { assessPaths, rejectFromPaths, rejectFromSearch } from "./quality.ts";
import type { CorpusEntry, Target } from "./types.ts";

/** Cases from one repo share its idioms; variety matters more than volume. */
const MAX_PER_REPO = 2;

export type MineStats = {
  reposSeen: number;
  reposGated: Record<string, number>;
  reposAccepted: number;
  commitsScanned: number;
  rejected: Record<Rejection, number>;
};

const bump = (rec: Record<string, number>, key: string) => {
  rec[key] = (rec[key] ?? 0) + 1;
};

/**
 * Repo-first mining.
 *
 * The message-first strategy searched commit text and landed on hobby projects:
 * of 25 cases only 2 could be executed. This inverts the order — find repos with
 * a real suite and a working manifest, then look inside their history for the
 * migration. Each repo costs one cheap core call to gate before we spend a
 * scarce search call on it.
 */
export async function mineByRepo(gh: GitHub, target: Target, want: number) {
  const entries: CorpusEntry[] = [];
  const stats: MineStats = {
    reposSeen: 0,
    reposGated: {},
    reposAccepted: 0,
    commitsScanned: 0,
    rejected: { merge: 0, noCode: 0, tooBig: 0, noSignal: 0 },
  };

  const seenRepos = new Set<string>();
  const seenSha = new Set<string>();

  outer: for (const repoQuery of target.repoQueries) {
    console.log(`\nrepos: "${repoQuery}"`);
    let repos: RepoHit[];
    try {
      repos = await gh.searchRepos(repoQuery);
    } catch (err) {
      console.warn(`  repo search failed: ${(err as Error).message}`);
      continue;
    }
    console.log(`  ${repos.length} candidates`);
    await new Promise((r) => setTimeout(r, gh.searchDelayMs));

    for (const repo of repos) {
      if (seenRepos.has(repo.full_name)) continue;
      seenRepos.add(repo.full_name);
      stats.reposSeen++;

      const cheapReject = rejectFromSearch(repo);
      if (cheapReject) {
        bump(stats.reposGated, cheapReject.replace(/\d+/g, "N"));
        continue;
      }

      // One core call decides whether this repo is worth a search call.
      let quality;
      try {
        const { paths } = await gh.listPaths(repo.full_name, repo.default_branch);
        quality = assessPaths(paths);
      } catch {
        bump(stats.reposGated, "tree unavailable");
        continue;
      }

      const pathReject = rejectFromPaths(quality);
      if (pathReject) {
        bump(stats.reposGated, pathReject.replace(/\d+/g, "N"));
        continue;
      }
      stats.reposAccepted++;

      // Now spend the scarce search call, scoped to this repo's history.
      let hits;
      try {
        hits = await gh.searchCommits(`repo:${repo.full_name} ${target.name}`);
      } catch (err) {
        console.warn(`  ${repo.full_name}: commit search failed`);
        continue;
      }
      await new Promise((r) => setTimeout(r, gh.searchDelayMs));
      if (!hits.length) continue;

      let fromThisRepo = 0;
      for (const hit of hits) {
        if (fromThisRepo >= MAX_PER_REPO) break;
        if (seenSha.has(hit.sha)) continue;

        if (gh.coreRemaining !== null && gh.coreRemaining < 5) {
          console.warn(`\n  core budget exhausted — stopping with ${entries.length} entries.`);
          break outer;
        }

        stats.commitsScanned++;
        let detail;
        try {
          detail = await gh.getCommit(repo.full_name, hit.sha);
        } catch {
          continue;
        }

        const verdict = classify(detail.files ?? [], detail.parents.length, target);
        if (!verdict.ok) {
          stats.rejected[verdict.reason]++;
          continue;
        }

        const { version, evidence, markers, manifestFiles, codeFiles } = verdict;
        const entry: CorpusEntry = {
          id: `${repo.full_name.replace("/", "__")}@${detail.sha.slice(0, 10)}`,
          library: target.name,
          repo: repo.full_name,
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
          stats: {
            codeFiles: codeFiles.length,
            additions: codeFiles.reduce((n, f) => n + f.additions, 0),
            deletions: codeFiles.reduce((n, f) => n + f.deletions, 0),
          },
          repoQuality: {
            stars: repo.stargazers_count,
            pushedAt: repo.pushed_at,
            hasTests: quality.hasTests,
            hasCI: quality.hasCI,
            hasLockfile: quality.hasLockfile,
            testFiles: quality.testFiles,
          },
        };

        entries.push(entry);
        seenSha.add(detail.sha);
        fromThisRepo++;

        console.log(
          `  ✓ ${repo.full_name}@${detail.sha.slice(0, 7)} ` +
            `★${repo.stargazers_count} ${quality.testFiles} test files` +
            `${quality.hasCI ? " +CI" : ""}${quality.hasLockfile ? " +lock" : ""} · ` +
            `${entry.stats.codeFiles} files` +
            (markers.length ? ` · ${markers.join(",")}` : ""),
        );

        if (entries.length >= want) break outer;
      }
    }
  }

  return { entries, stats };
}
