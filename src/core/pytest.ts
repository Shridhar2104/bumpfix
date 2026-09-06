import { run, tail } from "./exec.ts";

export type TestCounts = { passed: number; failed: number; errors: number; skipped: number };

export type TestResult = {
  /** False when pytest collected nothing or the run was killed — not a real verdict. */
  ran: boolean;
  passed: boolean;
  counts: TestCounts;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  output: string;
};

/** pytest's summary line, e.g. "3 failed, 12 passed, 1 skipped in 4.21s". */
export function parsePytest(out: string): TestCounts {
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  const line = out.split("\n").reverse().find((l) => /\d+ (passed|failed|error|skipped)/.test(l)) ?? "";
  for (const [, n, word] of line.matchAll(/(\d+) (passed|failed|errors?|skipped)/g)) {
    const key = word.startsWith("error") ? "errors" : (word as keyof TestCounts);
    counts[key] = Number(n);
  }
  return counts;
}

type PytestOpts = {
  cwd: string;
  /** Interpreter to invoke. In CI the ambient `python` already has deps installed. */
  python?: string;
  args?: string[];
  timeoutMs?: number;
  outputLines?: number;
};

export async function runPytest(opts: PytestOpts): Promise<TestResult> {
  const r = await run(
    opts.python ?? "python",
    ["-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider", ...(opts.args ?? [])],
    {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      env: { PYTHONDONTWRITEBYTECODE: "1", CI: "1" },
    },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  return {
    // null code = the interpreter itself failed to spawn; exit 5 = nothing collected.
    ran: r.code !== 5 && r.code !== null && !r.timedOut,
    passed: r.code === 0,
    counts: parsePytest(out),
    exitCode: r.code,
    timedOut: r.timedOut,
    ms: r.ms,
    output: tail(out, opts.outputLines ?? 40),
  };
}

export type CollectedTests = { count: number; ids: Set<string> };

/** Node-id lines from `pytest --collect-only -q` output. */
export function parseCollectedNodes(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("::"));
}

/**
 * What pytest would actually run. Compared before and after a fix so an agent
 * cannot turn the suite green by shrinking it — deleting tests, or deselecting
 * them via config edits (`-k`, `--ignore`, `addopts`). Ids are the real check;
 * the count is a fallback for pytest versions/plugins that print no node ids.
 * On "45/50 tests collected (5 deselected)" the SELECTED number is what runs.
 */
export async function collectTests(opts: PytestOpts): Promise<CollectedTests> {
  const r = await run(
    opts.python ?? "python",
    ["-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", ...(opts.args ?? [])],
    { cwd: opts.cwd, timeoutMs: 120_000, env: { PYTHONDONTWRITEBYTECODE: "1", CI: "1" } },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  const ids = new Set(parseCollectedNodes(r.stdout));
  const selected = out.match(/(\d+)\/\d+ tests? collected/);
  const total = out.match(/(\d+) tests? collected/);
  const count = selected ? Number(selected[1]) : total ? Number(total[1]) : ids.size;
  return { count, ids };
}
