# CLAUDE.md — Project Guide

## What is this
Express service that fetches Strapi CMS data, iteratively deepens nested relations, and recursively resolves component-instance (CI) entities. Returns fully-populated JSON via `GET /resolve/:collection`.

## Key files
- `src/server.js` — Express routes (only `/resolve/:collection`, `/webhook/strapi`, `/health`)
- `src/pageResolver.js` — Recursive CI resolution. Detects CIs by shape (documentId + component_title), not field name
- `src/strapiClient.js` — Strapi API client: 3-phase fetch (broad populate → iterative deepening → CI stub exposure) + Fragment API for dynamic zones
- `src/deepPopulate.js` — Tree walkers and populate param builders. Internal helpers (isStub, leafPaths) are NOT exported
- `src/cacheManager.js` — Redis/memory cache layer
- `data/valid.json` — 14-level deep reference JSON used as test ground truth
- `tests/pageResolver.test.js` — 13 tests, mock data derived from valid.json

## Commands
- `npx jest` — run tests (13 tests, all should pass)
- `node src/index.js` — start server (needs STRAPI_URL, STRAPI_TOKEN env vars)

## Architecture decisions
- CI detection is shape-based (documentId + component_title) so it works regardless of the Strapi field name
- `SKIP_KEYS = ['localizations']` — never treated as CI containers
- `CI_STOP_FIELDS = ['component_instance', 'component_instances']` — tree scan stops here; resolver batch-fetches CIs separately
- No `/page` route — removed; use `/resolve/pages?slug=...` instead
- `PageResolver.resolve()` is the only public resolution method
- Exports from deepPopulate.js are minimal; internal helpers stay private
- Test expected output accounts for resolver deduplication (same CI documentId → identical cached data everywhere)
- **No depth limits**: `maxPopulatePasses` defaults to 50 (safety cap only). Both `fetchEntry` and `fetchComponentInstance` loop until convergence (no new paths found), not until hitting the cap
- **Fragment deepening detects both stubs AND real objects** via `collectStubPaths` + `collectDeepPaths` combined in `buildFragmentDeepPathEntries`
- Convergence tracking is cumulative (all seen keys across all passes) to prevent redundant re-fetches
