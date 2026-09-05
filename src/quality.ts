import type { RepoHit } from "./github.ts";

/**
 * Repo-level gates.
 *
 * The message-first miner produced 25 cases of which only 2 could be executed:
 * 11 had no tests or no dependency manifest, 3 had unsatisfiable pins, and 8 had
 * suites that were already red. Searching commit messages selects for hobby
 * projects, because that is who writes "fix pydantic v2" instead of
 * "chore(deps): bump pydantic". These gates encode what went wrong, cheaply
 * enough to apply before spending a scarce search call on a repo.
 */

export const MIN_STARS = 40;
/** Abandoned projects have rotted dependencies that no longer install. */
export const PUSHED_SINCE = "2024-01-01";
/** The tree call is one core request; enormous repos are slow to probe later. */
export const MAX_SIZE_KB = 400_000;

export type RepoQuality = {
  hasTests: boolean;
  hasCI: boolean;
  hasManifest: boolean;
  /** Locks the dependency graph — a strong signal the environment reproduces. */
  hasLockfile: boolean;
  testFiles: number;
};

const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py)$/i;
const CI_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const MANIFEST = /^(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$|^requirements\/[^/]+\.txt$/i;
const LOCKFILE = /^(poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|requirements\.lock)$/i;

export function assessPaths(paths: string[]): RepoQuality {
  const testFiles = paths.filter((p) => TEST_FILE.test(p)).length;
  return {
    testFiles,
    hasTests: testFiles > 0,
    hasCI: paths.some((p) => CI_FILE.test(p)),
    hasManifest: paths.some((p) => MANIFEST.test(p)),
    hasLockfile: paths.some((p) => LOCKFILE.test(p)),
  };
}

/** Cheap rejection from the search payload alone — costs no extra API call. */
export function rejectFromSearch(r: RepoHit): string | null {
  if (r.fork) return "fork";
  if (r.archived) return "archived";
  if (r.stargazers_count < MIN_STARS) return `only ${r.stargazers_count} stars`;
  if (r.pushed_at < PUSHED_SINCE) return `stale since ${r.pushed_at.slice(0, 7)}`;
  if (r.size > MAX_SIZE_KB) return "too large";
  return null;
}

/**
 * Rejection from the file tree. Tests and a manifest are hard requirements —
 * without both there is nothing to run and no environment to build. CI is not
 * required but is the best available proxy for "the suite actually passes",
 * which is what sank 8 of the original 25.
 */
export function rejectFromPaths(q: RepoQuality): string | null {
  if (!q.hasManifest) return "no dependency manifest";
  if (!q.hasTests) return "no test files";
  if (q.testFiles < 3) return `only ${q.testFiles} test file(s)`;
  return null;
}
