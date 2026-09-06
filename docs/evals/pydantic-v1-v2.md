# bumpfix eval — pydantic v1 → v2

Generated 2026-09-05 · budget $3/case · 13 mined cases

**Fixed 3 of 8 attempted (38%)** · median cost $2.04 per attempt · 5 skipped (bump did not break the suite, or the environment failed)

Notes on the misses, for the curious:

- **authx** is a corpus artifact, not an engine failure — the mined commit was already migrated to v2, so there was no v1 code to fix; the agent investigated and correctly declined to force it. Excluding it, the rate is 3 of 7 (43%).
- **fastapi-hypermodel**'s fix modified `tests/app.py` — a fixture app that lives inside `tests/` — and bumpfix's never-touch-tests guard discards such fixes unconditionally. The safety contract outranks the win.
- **lnurl** hit the $3 budget ceiling mid-attempt; a higher `max-cost-usd` may well have landed it.

Every miss was silent: no push, no comment, no branch. That is the product working as designed — a failed attempt costs a capped few dollars, never credibility.

| Case | Result | Reason | Cost | Time |
|---|---|---|---|---|
| [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom/commit/905c2292512daecb1f83bd31eba8e200551c7387) | skipped | suite already green — no upgrade breakage to fix | $0.00 | — |
| [JoshuaC215/agent-service-toolkit](https://github.com/JoshuaC215/agent-service-toolkit/commit/24f86d200e56c1b1f6057729a6b85ebc8e950800) | fixed | 6 passed, 6 collected, 4 file(s) changed | $1.19 | — |
| [yezz123/authx](https://github.com/yezz123/authx/commit/c0f1b1e709b9a22490595ebe414f08ed81973a91) | not-fixed | agent made no changes: repo already migrated to pydantic v2 at this commit | $0.82 | — |
| [benavlabs/crudadmin](https://github.com/benavlabs/crudadmin/commit/c46a2733b1f853f6f8733ac8fa51ac9f0923a0c2) | skipped | suite already green — no upgrade breakage to fix | $0.00 | — |
| [mauvilsa/jsonargparse](https://github.com/mauvilsa/jsonargparse/commit/cfec5a2482918627ca3771c7378a0f6b08f2223f) | not-fixed | suite still red (1 failed, 0 errors) | $1.61 | — |
| [Zuehlke/ConfZ](https://github.com/Zuehlke/ConfZ/commit/30f7e0117a9566e6f92fe75966441a51e7a9d7af) | fixed | 43 passed, 43 collected, 2 file(s) changed | $2.07 | — |
| [graphql-python/graphene-pydantic](https://github.com/graphql-python/graphene-pydantic/commit/1fdf0010fadff702d3d320f44b3ef2bcbb5f2328) | not-fixed | suite still red (3 failed, 0 errors) | $2.34 | — |
| [ddanier/pydantic-partial](https://github.com/ddanier/pydantic-partial/commit/3398fd63719c7ad1e21d7129d4dc264ec1900dab) | skipped | suite already green — no upgrade breakage to fix | $0.00 | — |
| [lnbits/lnurl](https://github.com/lnbits/lnurl/commit/3c78450ccae1232de3c3e2217094d2ceaa105d52) | not-fixed | budget exhausted ($3) before the suite went green | $3.00 | — |
| [dhvcc/rss-parser](https://github.com/dhvcc/rss-parser/commit/1d77d466fa08f2dfa19f15bffc2b8fb630fed318) | fixed | 16 passed, 16 collected, 5 file(s) changed | $1.84 | 6.5m |
| [jtc42/fastapi-hypermodel](https://github.com/jtc42/fastapi-hypermodel/commit/71dbe813647156235e9e44902751ab3d5dc1133f) | not-fixed | rejected — agent modified tests: tests/app.py | $2.04 | 7.6m |
| [surenkov/django-pydantic-field](https://github.com/surenkov/django-pydantic-field/commit/fb6c844e692d7c5e29d9678354bd3215c90e9952) | skipped | suite already green — no upgrade breakage to fix | $0.00 | 0.1m |
| [phalt/clientele](https://github.com/phalt/clientele/commit/a44dc12d41b336d95ebd214c89abe0cb93b6508a) | skipped | suite already green — no upgrade breakage to fix | $0.00 | 0.2m |
