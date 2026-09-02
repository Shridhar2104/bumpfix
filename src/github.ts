import type { ChangedFile } from "./types.ts";

const BASE = "https://api.github.com";

export type CommitHit = {
  sha: string;
  commit: { message: string; committer: { date: string } };
  repository: { full_name: string };
  html_url: string;
};

type CommitDetail = {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; committer: { date: string } };
  html_url: string;
  files?: ChangedFile[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHub {
  private token = process.env.GITHUB_TOKEN;

  get authed() {
    return Boolean(this.token);
  }

  /** Search is the tightest limit: 30/min authenticated, 10/min without. */
  get searchDelayMs() {
    return this.authed ? 2100 : 6500;
  }

  /** Core budget left, as of the last core request. Null until one is made. */
  coreRemaining: number | null = null;

  async rateLimit() {
    const data = await this.request<{
      resources: Record<string, { limit: number; remaining: number; reset: number }>;
    }>("/rate_limit");
    this.coreRemaining = data.resources.core.remaining;
    return data.resources;
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "breaking-change-miner",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers });
      if (res.ok) return (await res.json()) as T;

      const rateLimited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");

      if (rateLimited) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const waitMs = retryAfter
          ? retryAfter * 1000
          : reset
            ? Math.max(0, reset * 1000 - Date.now()) + 1000
            : 30_000;
        console.warn(`  rate limited, waiting ${Math.ceil(waitMs / 1000)}s`);
        await sleep(Math.min(waitMs, 120_000));
        continue;
      }

      if (res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }

      throw new Error(`GitHub ${res.status} on ${url.pathname}: ${await res.text()}`);
    }
    throw new Error(`GitHub request failed after retries: ${url.pathname}`);
  }

  async searchCommits(q: string, page = 1): Promise<CommitHit[]> {
    const data = await this.request<{ items: CommitHit[] }>("/search/commits", {
      q,
      per_page: "100",
      page: String(page),
      sort: "committer-date",
      order: "desc",
    });
    return data.items ?? [];
  }

  async getCommit(repo: string, sha: string) {
    const detail = await this.request<CommitDetail>(`/repos/${repo}/commits/${sha}`);
    if (this.coreRemaining !== null) this.coreRemaining--;
    return detail;
  }
}
