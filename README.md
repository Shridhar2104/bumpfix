# greenbump

**When a dependency's major-version bump breaks your build, greenbump fixes
your code — in your own CI, verified against your own tests.**

Dependabot opens a PR bumping `pydantic` to v2. Your suite goes red. A few
minutes later a commit lands on that same PR migrating your code to the new
API, ready for your checks to rerun green. That's the whole product.

**See it on a real PR:** [greenbump-demo#1](https://github.com/Shridhar2104/greenbump-demo/pull/1)
— a pydantic 1.10 → 2.9 bump turns the suite red, and greenbump's commit
migrates two source files (`@validator` → `@field_validator`, `const=` →
`Literal`, `.dict()` → `model_dump`, …) back to 10/10 green. $0.39, 5 turns,
no test file touched.

## How it works

1. A PR changes a Python manifest (`requirements.txt`, `pyproject.toml`,
   a lockfile). greenbump diffs it and finds packages whose **major** version
   increased.
2. It runs your test suite. Already green? It stops — nothing to fix.
3. If the bump broke the suite, an agent (Claude) edits your **source code**
   under a hard cost ceiling, rerunning your tests until they pass.
4. Only when the suite is genuinely green — and no test file was touched —
   does it commit and push the fix onto the PR branch and leave one comment.

## What it will never do

- **Fail your build.** Every path exits 0. greenbump is an extra chance, not a
  gate.
- **Ship an unverified fix.** No green suite, no push, no comment. Silence.
- **Touch your tests.** Fixes that edit, skip, or weaken tests are discarded.
  It also verifies the number of collected tests did not drop.
- **Exceed the budget.** `max-cost-usd` (default $3) is a hard ceiling.
- **Send your code anywhere.** It runs in your CI with your API key. There is
  no greenbump server.

## Setup

Add `.github/workflows/greenbump.yml` — see [examples/workflow.yml](examples/workflow.yml):

- `permissions: contents: write` + `pull-requests: write`
- `actions/checkout` with `ref: ${{ github.head_ref }}` (so the fix can land
  on the PR; without it greenbump falls back to pushing a separate branch)
- your usual dependency install step
- the action, with `ANTHROPIC_API_KEY` in secrets

**Dependabot note:** workflows triggered by Dependabot PRs read secrets from
*Dependabot secrets*, not Actions secrets. Add `ANTHROPIC_API_KEY` under
**Settings → Secrets and variables → Dependabot** too.

**Don't use `pull_request_target`:** it checks out the PR head under a
privileged context, which is a known way to hand a fork write access to your
secrets. Use `pull_request` as shown above.

**Re-running your checks:** a push made with the default `${{ github.token }}`
does not re-trigger workflow runs — that's a GitHub anti-recursion guard, not
a bug. After greenbump comments, re-run the failed checks manually, or set
`github-token` to a PAT or GitHub App token to have them rerun automatically.
(If you pass a PAT, pass it via the `github-token` input — it takes precedence
over any ambient `GITHUB_TOKEN` env var.)

**Fork PRs:** gate the job with
`if: github.event.pull_request.head.repo.full_name == github.repository`
(as in the example workflow). Fork PRs can't read your secrets, and the
`head_ref` checkout only exists for same-repo branches — Dependabot's included.

## Results

Measured on real-world open-source migrations mined from GitHub (each case is
a repo whose suite was green before the bump and red after):

On 13 pydantic v1 → v2 bumps mined from real GitHub repos: 5 didn't actually
break the suite (greenbump correctly stayed silent), and of the **8 that
broke, greenbump fixed 3 (38%)** — median cost **$2.04** per attempt, no test
file touched, no unverified fix shipped. One miss was a fix rejected by the
never-touch-tests guard, one hit the $3 budget ceiling; every miss was
silent.

See [docs/evals/pydantic-v1-v2.md](docs/evals/pydantic-v1-v2.md) for the
per-case table with links to each real commit.

## Configuration

| Input | Default | What it does |
|---|---|---|
| `library` | *(auto-detect)* | Override detection and fix this package |
| `from-version` / `to-version` | *(from diff)* | Versions, when overriding |
| `python` | `python` | Interpreter with your deps installed |
| `working-directory` | workspace | Directory to run in |
| `max-cost-usd` | `3` | Hard spend ceiling for the whole run |
| `max-turns` | `40` | Max agent turns per attempt |
| `branch` | generated | Fallback branch when in-place push isn't safe |
| `github-token` | `github.token` | Needs `contents:write`, `pull-requests:write` |

Outputs: `fixed` (`"true"`/`"false"`) and `outcome-file` (path to a JSON
record of the run: what was detected, attempted, spent, and delivered).

## FAQ

**Which upgrades does it handle?** Any Python package whose major version
bumped. Python-only for now.

**What if several majors bump in one PR?** Each is attempted sequentially
sharing one budget; each verified fix is its own commit.

**What does it cost?** Your Anthropic API usage, capped by `max-cost-usd`.
Failed attempts still consume what they used before giving up.

**Why did it stay silent on my PR?** It couldn't produce a verified fix
within budget. The step summary in the workflow run has the full story.
