# Greenbump v1 Public Launch — Design

**Date:** 2026-09-05
**Status:** Approved
**Goal:** Ship greenbump as a free, open-source GitHub Action anyone can install
from the GitHub Marketplace, backed by published eval numbers and a live demo —
structured so the future paid GitHub App reuses the fix engine unchanged.

## Decisions this design rests on

| # | Question | Decision |
|---|---|---|
| D1 | Launch shape | Free polished Action now; hosted GitHub App is the later paid tier. Stage 1 specced with stage 2's constraints in mind. |
| D2 | Where the fix lands | Push the fix commit onto the bump PR's own branch (in place), with a separate-branch fallback when the head has moved. |
| D3 | Upgrade scope | Any Python library whose major version bumped, auto-detected from the manifest diff. `library:` input becomes an optional override. |
| D4 | Proof before launch | Run the pydantic v1→v2 eval corpus and build a public demo repo before announcing. |
| D5 | Paid-tier seam | Hosted GitHub App. Seams cut now: core/wrapper module split, structured outcome record, PR-comment UX shared by both tiers. |

## 1. Product summary

Greenbump watches dependency-bump PRs (Dependabot, Renovate, or manual). When a
Python package's **major version** changes in a manifest, it runs the
customer's test suite; if the bump broke it, an agent fixes the *source* code
under a hard cost cap, re-verifies, and **pushes the fix commit directly onto
the PR branch** — the red PR turns green. It stays completely silent unless the
suite actually passes, and it can never fail the customer's build (every path
exits 0). The customer brings their own Anthropic API key; their code never
leaves their CI.

## 2. Architecture: core/wrapper split (the monetization seam)

Restructure `src/` into three layers with one interface between the first two:

- **`src/core/`** — the fix engine, GitHub-agnostic: `agent.ts`, `pytest.ts`,
  `exec.ts`, plus new `detect.ts` and `outcome.ts`. Input: `FixRequest` (cwd,
  library, versions, budget, turns, python). Output: `FixOutcome`. No knowledge
  of Actions, PRs, or git pushing. The paid App imports this verbatim later.
- **`src/action/`** — the GitHub Action wrapper: reads inputs/env, calls
  detection, calls the engine, handles git push, PR comment, step summary, and
  exit-0 discipline.
- **`src/eval/`** — the existing miner/validator/sandbox
  (`mine.ts`, `mine-repos.ts`, `validate.ts`, `sandbox.ts`, `github.ts`,
  `filter.ts`, `quality.ts`, `targets.ts`) plus a new `run-eval.ts` harness.
  Never bundled into `dist/`.

Every run emits a **structured outcome record** (`outcome.ts`): library,
from/to version, result and reason, cost USD, turns, test counts before/after,
files changed, duration. Written to the step summary and to a JSON artifact.
This schema is the future billing/metering record — designed once, here.

## 3. Auto-detection (`src/core/detect.ts`)

- Diff the PR's changed manifests between base and head:
  `requirements*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`,
  `Pipfile.lock`, `setup.py`, `setup.cfg`.
- Extract packages whose **major** version increased — any increase of the
  leftmost version component, so `0.x → 1.0` counts — → list of
  `{library, fromVersion, toVersion}`.
- Multiple majors in one PR: attempt each sequentially, sharing one budget cap;
  each attempt gets its own entry in the outcome record.
- `library:` input remains as an optional override and as the escape hatch for
  non-PR usage (e.g. `workflow_dispatch`).
- Nothing detected → log one line, exit 0, no comment, no noise.

## 4. Fix delivery: in-place with a safety latch

On a verified green suite:

1. Commit the fix — source files only; the existing artifact and test-file
   stripping stays.
2. **Guard:** re-fetch the remote PR head. If it moved since checkout
   (Dependabot rebased), do *not* push to it — fall back to pushing a separate
   fix branch, and say so in the comment.
3. Push to the PR head branch.
4. Post one PR comment: what broke, what was changed, test delta, cost.
   Requires `pull-requests: write` alongside `contents: write`. A comment
   failure is non-fatal (fix is already pushed; warn only).

On failure: no push, no comment (silence is the brand); outcome recorded in the
step summary only.

**Documented setup caveats (README, prominent):** Dependabot-triggered
workflows do not receive repository secrets by default. Recommended route:
add `ANTHROPIC_API_KEY` to Dependabot secrets. The `pull_request_target`
alternative is documented with a warning, not recommended (checkout-of-PR-head
under `pull_request_target` is a known footgun).

## 5. Proof: eval run + demo repo (launch gate)

- **`src/eval/run-eval.ts`**: for each validated corpus case (pydantic v1→v2
  first), spin the sandbox at the pre-migration commit with the post-bump
  dependency installed, run the fix engine, score pass/fail against the case's
  own suite, aggregate fix-rate and median cost. Results committed to
  `docs/evals/pydantic-v1-v2.md` with a per-case table. Budget: $3 cap × N
  validated cases (expected $50–150 total). sqlalchemy and openai evals are
  post-launch follow-ups.
- **Demo repo** (`Shridhar2104/greenbump-demo`): a small real pydantic v1 app
  with tests, Dependabot config, and one preserved PR where the bump went red
  and greenbump's commit turned it green. Linked from the README as the
  inspect-it-yourself receipt.

## 6. Launch assets

- **README**: hero (red→green PR screenshot), 3-step setup, safety story
  (your CI, your key, silent on failure, cost cap, never breaks the build),
  eval table, config reference, FAQ.
- **`v1` tag** and GitHub Marketplace listing (branding already in
  `action.yml`).
- **Repo CI** (`.github/workflows/ci.yml`): tests + typecheck + `dist/` drift
  check (rebuild, then `git diff --exit-code dist/`).
- `examples/workflow.yml` updated to the auto-detect form (no `library` input).

## 7. Error handling and invariants

| Situation | Behavior |
|---|---|
| Any crash / timeout / budget exceeded | exit 0, reason in step summary |
| Tests already green after bump | exit 0, "nothing to fix" |
| Tests fail before *and* after agent | exit 0, no push, no comment |
| PR head moved during run | separate-branch fallback + comment notes it |
| No majors detected | exit 0, one log line |
| Comment API fails | fix stays pushed; non-fatal warning |

## 8. Testing

- **Unit:** `detect.ts` manifest-diff parsing (all supported manifest formats,
  pre-release versions, `>=` ranges, extras), outcome serialization,
  head-moved guard logic. The existing 26 tests keep passing.
- **Integration:** the demo repo doubles as the end-to-end smoke test; the eval
  run is the at-scale verification of the engine itself.

## 9. Out of scope (stage 2+)

Hosted GitHub App, billing, any telemetry or phone-home, JS/TS support,
license keys, sqlalchemy/openai eval publication.
