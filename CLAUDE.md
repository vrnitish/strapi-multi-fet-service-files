# CLAUDE.md — Project Guide

## What is this
Express microservice that sits in front of Strapi CMS. Fetches entries, iteratively deepens all nested relations, and recursively resolves component-instance (CI) entities. Returns fully-populated JSON that mirrors Strapi's REST response shape.

## Key files
- `src/server.js` — Express routes + proxy logic + cache
- `src/pageResolver.js` — Recursive CI resolution. Public methods: `resolve()`, `resolveWithMeta()`, `resolveById()`
- `src/strapiClient.js` — Strapi API client: Phase 1 (populate=*) → Phase 2 (iterative deepening) → Phase 3 (localizations) + Fragment API for dynamic zones. Public: `fetchEntry`, `fetchEntryWithMeta`, `fetchByDocumentId`, `fetchBatchByDocumentId`, `proxyGet`
- `src/deepPopulate.js` — Tree walkers and populate param builders. `buildDeepPopulateParams` accepts `rawQuery` option to use request params as base
- `src/cacheManager.js` — Redis/memory cache layer
- `src/index.js` — Server entry point, reads env vars
- `data/valid.json` — Reference JSON (deep, multi-level) used as test ground truth
- `tests/pageResolver.test.js` — 13 tests, mock data derived from valid.json
- `tests/strapiClient.test.js` — 11 tests
- `tests/deepPopulate.test.js` — 8 tests

## Commands
- `npx jest` — run all tests (32 total, all should pass)
- `node src/index.js` — start server

## Routes
```
GET  /health                            → { status: 'ok', timestamp }
GET  /api/:collection/:documentId       → single document by documentId
GET  /api/:collection                   → list / filtered entries
POST /webhook/strapi                    → cache invalidation
```

## Query param handling (GET routes)

ALL Strapi-native query params are passed through to Strapi as-is.
`depth` is the only param stripped before forwarding.

**Two modes based on whether `populate` is present:**

1. **Proxy mode** (`populate` in query) — `depth` is ignored entirely:
   - Request is forwarded directly to Strapi with all params (including populate)
   - No deepening pipeline runs
   - Example: `GET /pages?filters[slug][$eq]=/page/&populate=*`

2. **Depth pipeline mode** (no `populate`) — our deepening runs:
   - `depth=1` (default) — Phase 1 only (populate=* + sort/pagination/etc passed through)
   - `depth=N` — N-1 iterative deepening passes, no CI resolution
   - `depth=full` — full pipeline: deepening + CI resolution + localizations
   - `depth=<other>` → 400 error
   - All other params (sort, pagination, fields, locale, filters, status, etc.) pass through to every Strapi request in the pipeline
   - Example: `GET /pages/abc123?depth=full`
   - Example: `GET /pages?filters[slug][$eq]=/page/&sort[0]=title:asc&pagination[page]=2&depth=2`

## Architecture decisions
- **`rawQuery` passthrough**: `_fetchEntryEnvelope` accepts `rawQuery` (Strapi-native query string minus `depth`). Used as base for every Strapi request so sort/pagination/fields/etc are always forwarded.
- **CI detection is shape-based** (documentId + entityLabelField) — works regardless of field name
- **`buildDeepPopulateParams(paths, { rawQuery })`** — when rawQuery is provided, uses it as URLSearchParams base instead of building from `{ filters, locale }`
- **Proxy mode**: `strapiClient.proxyGet(path, queryString)` forwards request directly to Strapi
- `SKIP_KEYS = ['localizations']` — never scanned for CI relations
- `CI_STOP_FIELDS = ['component_instance', 'component_instances']` — tree scan stops here; resolver batch-fetches CIs separately
- No depth limits: `maxPopulatePasses` defaults to 50 (convergence cap only)
- Fragment deepening: `collectStubPaths` + `collectDeepPaths` combined in `buildFragmentDeepPathEntries`
- Convergence tracking is cumulative across all passes
- `ALWAYS_POPULATE_FIELDS` env var: fields Strapi omits when null (e.g. seo_elements) — forced via Phase 1b
- Localizations: Phase 3 queries `/api/i18n/locales` and fetches each other locale by documentId directly (Strapi v5 REST returns `localizations: []` even when versions exist)

## Configurable schema (env vars)
```
ENTITY_LABEL_FIELD=component_title   # field that identifies CI entities
LOCALIZATION_FIELD=localizations     # skipped during tree scan
COMPONENT_TYPE_FIELD=__component     # dynamic zone UID field
COMPONENT_ZONE_FIELD=components      # dynamic zone field name
COMPONENT_COLLECTION=component-instances
COLLECTION_KEYS=field:collection,... # maps relation field names → collection API names
ALWAYS_POPULATE_FIELDS=seo_elements  # comma-separated fields to force-populate when null
LOCALES=en,hi                        # optional override; auto-discovered from /api/i18n/locales if unset
```

## Data flow (depth=full)
1. `server.js` strips `depth`, builds `rawQuery`, detects `populate`
2. `resolver.resolveWithMeta(collection, filters, locale, { maxDepth, rawQuery })`
3. `strapiClient._fetchEntryEnvelope`:
   - Phase 1: `rawQuery + populate=*` → broad fetch
   - Phase 1b: explicit populate for `ALWAYS_POPULATE_FIELDS` if missing
   - Phase 2: iterative deepening (`rawQuery` as base + deep populate params) until convergence
   - Phase 3: fetch other locales by documentId, populate `localizations` field
4. `pageResolver._deepResolve`: scan for CI stubs → batch-fetch by collection → replace stubs → recurse until no new CIs
5. Return `{ data: [resolved], meta: { pagination: {...} } }`

## Test conventions
- Mock data derived from `data/valid.json` via `buildMocksFromValid()`
- Tests expect `rawQuery: null` in `fetchEntry` / `fetchEntryWithMeta` call assertions
- Expected output built via `buildExpected()` which accounts for resolver deduplication
