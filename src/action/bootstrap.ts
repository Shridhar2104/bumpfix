import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, tail } from "../core/exec.ts";

/** Must match the bundled @anthropic-ai/claude-agent-sdk version. */
const SDK_VERSION = "0.3.252";

const BIN = process.platform === "win32" ? "claude.exe" : "claude";

/**
 * The SDK's agent loop is a native binary shipped as a platform-specific
 * optional npm package, which the bundled action cannot resolve — a CI runner
 * has no node_modules. Install just that package once per run and hand the
 * SDK the binary path. Returns null on failure; the SDK then reports its own
 * clear error and the action stays silent, as always.
 */
export async function ensureClaudeBinary(): Promise<string | null> {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;

  // Dev fast path: running from a checkout with node_modules present.
  try {
    const local = join(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)), BIN);
    if (existsSync(local)) return local;
  } catch {
    // bundled run — fall through to the install path
  }

  const prefix = join(process.env.RUNNER_TEMP || tmpdir(), "greenbump-cli");
  const binary = join(prefix, "node_modules", pkg, BIN);
  if (existsSync(binary)) return binary;

  console.log(`greenbump: fetching agent runtime (${pkg}@${SDK_VERSION})…`);
  const r = await run(
    "npm",
    ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", `${pkg}@${SDK_VERSION}`],
    { timeoutMs: 300_000 },
  );
  if (!r.ok || !existsSync(binary)) {
    console.warn(`greenbump: could not fetch agent runtime: ${tail(r.stderr, 3)}`);
    return null;
  }
  return binary;
}
