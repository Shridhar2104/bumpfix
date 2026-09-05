import { readFile } from "node:fs/promises";

/** Everything delivery needs to know about the PR the run belongs to. */
export type PrContext = {
  repo: string;
  prNumber: number;
  headRef: string;
  headSha: string;
  baseSha: string;
};

type PrPayload = {
  pull_request?: {
    number?: number;
    head?: { ref?: string; sha?: string };
    base?: { sha?: string };
  };
};

export function parsePrContext(
  eventName: string | undefined,
  repo: string | undefined,
  payload: unknown,
): PrContext | null {
  if (eventName !== "pull_request" && eventName !== "pull_request_target") return null;
  if (!repo) return null;
  const pr = (payload as PrPayload).pull_request;
  if (!pr?.number || !pr.head?.ref || !pr.head?.sha || !pr.base?.sha) return null;
  return {
    repo,
    prNumber: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
  };
}

export async function loadPrContext(): Promise<PrContext | null> {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  return parsePrContext(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REPOSITORY, payload);
}
