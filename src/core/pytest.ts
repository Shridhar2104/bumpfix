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
    ran: r.code !== 5 && !r.timedOut,
    passed: r.code === 0,
    counts: parsePytest(out),
    exitCode: r.code,
    timedOut: r.timedOut,
    ms: r.ms,
    output: tail(out, opts.outputLines ?? 40),
  };
}

/**
 * How many tests pytest can collect. Compared before and after a fix so an
 * agent cannot turn the suite green by removing tests from it.
 */
export async function collectCount(opts: PytestOpts): Promise<number> {
  const r = await run(
    opts.python ?? "python",
    ["-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
    { cwd: opts.cwd, timeoutMs: 120_000, env: { PYTHONDONTWRITEBYTECODE: "1", CI: "1" } },
  );
  const m = `${r.stdout}\n${r.stderr}`.match(/(\d+) tests? collected/);
  if (m) return Number(m[1]);
  // Older pytest prints one node id per line and no summary.
  return r.stdout.split("\n").filter((l) => l.includes("::")).length;
}
