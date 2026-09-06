import { execFile } from "node:child_process";

export type Run = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
};

/**
 * Run a command without a shell. Never throws on a non-zero exit — callers
 * branch on `code`, because a failing test suite is data, not an error.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: "SIGKILL",
        env: { ...process.env, ...opts.env },
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        // A string code (ENOENT, EACCES) means the command never ran at all —
        // callers must not read that as "ran and failed" (exit 1).
        const spawnFailed = typeof e?.code === "string";
        resolve({
          ok: !e,
          code: typeof e?.code === "number" ? e.code : spawnFailed ? null : e ? 1 : 0,
          stdout: stdout ?? "",
          stderr: (stderr ?? "") || (spawnFailed ? e!.message : ""),
          timedOut: Boolean(e?.killed),
          ms: Date.now() - started,
        });
      },
    );
  });
}

/** Trailing slice of output, for logs and failure records. */
export const tail = (s: string, lines = 25) => s.trimEnd().split("\n").slice(-lines).join("\n");
