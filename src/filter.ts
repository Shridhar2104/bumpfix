import type { ChangedFile, Target } from "./types.ts";

/** Skip sweeping refactors; they teach the agent nothing specific. */
export const MAX_CODE_FILES = 25;

export type Rejection = "merge" | "noCode" | "tooBig" | "noSignal";

export type Accepted = {
  ok: true;
  /** Null when accepted on markers alone — the bump landed in another commit. */
  version: { from: string; to: string } | null;
  evidence: "manifest" | "markers";
  markers: string[];
  manifestFiles: ChangedFile[];
  codeFiles: ChangedFile[];
};

export type Verdict = Accepted | { ok: false; reason: Rejection };

const removedLines = (f: ChangedFile) =>
  (f.patch ?? "").split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
const addedLines = (f: ChangedFile) =>
  (f.patch ?? "").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));

/**
 * Read a major-version change out of a manifest diff.
 *
 * Heuristic by nature: manifests are written a dozen ways and we only inspect
 * lines that mention the package. Returns null unless a removed line pins the
 * old major and an added line pins the new one — so an unrelated version
 * elsewhere in the file cannot fake a match on its own.
 */
export function parseVersionChange(files: ChangedFile[], target: Target) {
  const versionOn = (line: string) => {
    if (!line.toLowerCase().includes(target.name)) return null;
    const m = line.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    return m ? { major: Number(m[1]), text: m[0] } : null;
  };

  let from: string | null = null;
  let to: string | null = null;

  for (const f of files) {
    for (const line of removedLines(f)) {
      const v = versionOn(line);
      if (v && v.major === target.fromMajor) from ??= v.text;
    }
    for (const line of addedLines(f)) {
      const v = versionOn(line);
      if (v && v.major === target.toMajor) to ??= v.text;
    }
  }

  return from && to ? { from, to } : null;
}

/**
 * Which known API changes this diff performs — a line removed matching `from`
 * and a line added matching `to`, anywhere in the same file.
 */
export function detectMarkers(files: ChangedFile[], target: Target): string[] {
  const hits = new Set<string>();
  for (const f of files) {
    const removed = removedLines(f).join("\n");
    const added = addedLines(f).join("\n");
    for (const m of target.markers) {
      if (m.from.test(removed) && m.to.test(added)) hits.add(m.label);
    }
  }
  return [...hits].sort();
}

/**
 * Decide whether a commit is a usable eval case.
 *
 * Two ways in. A manifest that crosses the major boundary is the strong signal.
 * Failing that, known API markers in the source diff also qualify — in real
 * repos the version bump and the code fix are routinely separate commits, which
 * is precisely the situation this product exists to handle.
 */
export function classify(
  files: ChangedFile[],
  parentCount: number,
  target: Target,
  maxCodeFiles = MAX_CODE_FILES,
): Verdict {
  if (parentCount !== 1) return { ok: false, reason: "merge" };

  const codeFiles = files.filter((f) => target.source.test(f.filename) && f.patch);
  if (!codeFiles.length) return { ok: false, reason: "noCode" };
  if (codeFiles.length > maxCodeFiles) return { ok: false, reason: "tooBig" };

  const manifestFiles = files.filter((f) => target.manifests.test(f.filename));
  const version = parseVersionChange(manifestFiles, target);
  const markers = detectMarkers(codeFiles, target);

  if (version) return { ok: true, version, evidence: "manifest", markers, manifestFiles, codeFiles };
  if (markers.length) return { ok: true, version: null, evidence: "markers", markers, manifestFiles, codeFiles };

  return { ok: false, reason: "noSignal" };
}
