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
