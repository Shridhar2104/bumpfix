/** A library whose major-version migration we mine for. */
export type Target = {
  /** Package name as it appears in a manifest. */
  name: string;
  /** Major version the migration goes from → to. */
  fromMajor: number;
  toMajor: number;
  /** Manifest files whose diff should show the version change. */
  manifests: RegExp;
  /** Source files that count as the human fix. */
  source: RegExp;
  /** Commit-search phrases. More variants = better recall. */
  queries: string[];
  /**
   * Known API changes for this migration. A diff that removes `from` and adds
   * `to` is a migration even when the version bump landed in another commit.
   */
  markers: { label: string; from: RegExp; to: RegExp }[];
  /**
   * Repo-search queries for the repo-first strategy. Aim at projects that
   * certainly depend on this library and plausibly have a maintained suite.
   */
  repoQueries: string[];
};

/** One changed file, as GitHub returns it. */
export type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

/**
 * One eval case: a real commit where a human migrated a codebase across a
 * major version. The code diff is the ground truth we score an agent against.
 */
export type CorpusEntry = {
  id: string;
  library: string;
  repo: string;
  sha: string;
  /** State of the tree the agent would start from. */
  parentSha: string;
  url: string;
  message: string;
  committedAt: string;
  /** Null when the case was accepted on code markers alone. */
  version: { from: string; to: string } | null;
  /** How we established this is a migration. */
  evidence: "manifest" | "markers";
  /** Which known API changes appear in the diff — the eval breakdown key. */
  markers: string[];
  /** Dependency-manifest changes — the part Renovate already does. */
  manifestFiles: ChangedFile[];
  /** Source changes — the part nobody automated. This is the label. */
  codeFiles: ChangedFile[];
  stats: { codeFiles: number; additions: number; deletions: number };
  /** Present when mined repo-first; the signals that got this repo accepted. */
  repoQuality?: {
    stars: number;
    pushedAt: string;
    hasTests: boolean;
    hasCI: boolean;
    hasLockfile: boolean;
    testFiles: number;
  };
};
