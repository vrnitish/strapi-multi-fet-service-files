const axios = require('axios');
const {
  collectStubPaths,
  collectDeepPaths,
  uniquePaths,
  buildDeepPopulateParams,
  buildFragmentDeepPathEntries,
  normalizeSchema,
} = require('./deepPopulate');

class StrapiClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.timeout = config.timeout || 10000;
    this.maxPopulatePasses = config.maxPopulatePasses || 50;
    this.schema = normalizeSchema({
      entityLabelField: config.entityLabelField,
      localizationField: config.localizationField,
      componentTypeField: config.componentTypeField,
      componentZoneField: config.componentZoneField,
    });
    this.componentCollection = config.componentCollection || 'component-instances';

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    this.http.interceptors.request.use((req) => {
      console.log(`[Strapi] ${req.method?.toUpperCase()} ${req.url}`);
      return req;
    });
  }

  _buildLocalizationPopulateEntry() {
    return [`populate[${this.schema.localizationField}]`, '*'];
  }

  /**
   * Deep-merge two Strapi responses.
   * Keeps earlier data only when the newer payload omits a key entirely.
   * Explicit newer values such as null and [] must win, otherwise relations
   * that are intentionally empty disappear behind stale data from prior passes.
   */
  _mergeResponses(base, update) {
    if (update === undefined) return base;
    if (base === undefined) return update;
    if (
      base == null ||
      update == null ||
      typeof base !== 'object' ||
      typeof update !== 'object'
    ) {
      return update;
    }
    if (Array.isArray(base) || Array.isArray(update)) {
      if (!Array.isArray(base) || !Array.isArray(update)) return update;
      return update.map((item, i) => this._mergeResponses(base[i], item));
    }
    const result = { ...base };
    for (const [key, val] of Object.entries(update)) {
      if (
        key in result &&
        result[key] != null &&
        val != null &&
        typeof result[key] === 'object' &&
        typeof val === 'object'
      ) {
        result[key] = this._mergeResponses(result[key], val);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  async _populateLocalizationsForEntry(collection, entry, { filters = {}, locale = 'en' } = {}) {
    try {
      const res = await this.http.get(
        `/api/${collection}?${buildDeepPopulateParams([], {
          locale,
          filters,
          extraEntries: [this._buildLocalizationPopulateEntry()],
        })}`
      );
      const data = res.data?.data;
      const localizationEntry = Array.isArray(data) ? data[0] : data;
      return localizationEntry ? this._mergeResponses(entry, localizationEntry) : entry;
    } catch (err) {
      console.warn(
        `[Strapi] ${collection} localization populate skipped (${err.response?.status ?? err.message})`
      );
      return entry;
    }
  }

  async _fetchEntryEnvelope(collection, { filters = {}, locale = 'en' } = {}) {
    let meta;

    // ── Phase 1: Broad populate ───────────────────────────────────────────
    const params1 = new URLSearchParams();
    for (const [field, value] of Object.entries(filters)) {
      params1.set(`filters[${field}][$eq]`, value);
    }
    if (locale) params1.set('locale', locale);
    params1.set('populate', '*');

    const firstRes = await this.http.get(`/api/${collection}?${params1}`);
    const firstData = firstRes.data?.data;
    meta = firstRes.data?.meta;

    let entry = Array.isArray(firstData) ? firstData[0] : firstData;
    if (!entry) {
      throw new Error(`No entry found in ${collection} with filters: ${JSON.stringify(filters)}`);
    }

    // populate=* does not reliably include i18n localizations, so fetch them explicitly
    entry = await this._populateLocalizationsForEntry(collection, entry, { filters, locale });

    // ── Phase 2: Iterative deepening ─────────────────────────────────────
    // Detects both stubs (under-populated entities) AND real-object arrays
    // whose items may have absent sub-relations. Deepens one level per pass;
    // merge preserves breadth from earlier passes.
    // stopAtEntities: false — the page-level scanner traverses THROUGH all
    // relations regardless of which collection they belong to. Strapi resolves
    // cross-collection populate params transparently, so we don't need to
    // know the collection name for any nested relation.
    let allPaths = [];
    for (let pass = 2; pass <= this.maxPopulatePasses; pass++) {
      const stubPaths = collectStubPaths(entry, { schema: this.schema, stopAtEntities: false });
      const deepPaths = collectDeepPaths(entry, { schema: this.schema, stopAtEntities: false });
      const combined = uniquePaths([...stubPaths, ...deepPaths]);

      // Check if any truly new paths were discovered
      const prevKeys = new Set(allPaths.map((p) => p.join('\0')));
      const newPaths = combined.filter((p) => !prevKeys.has(p.join('\0')));
      if (newPaths.length === 0) break;

      allPaths = uniquePaths([...allPaths, ...combined]);
      console.log(`[Strapi] ${collection} pass ${pass}: ${newPaths.length} new path(s) — deepening`);

      const deepRes = await this.http.get(
        `/api/${collection}?${buildDeepPopulateParams(allPaths, { locale, filters })}`
      );
      const newData = deepRes.data?.data;
      const newEntry = Array.isArray(newData) ? newData[0] : newData;
      if (!newEntry) break;
      entry = this._mergeResponses(entry, newEntry);
    }

    return { entry, meta };
  }

  /**
   * Fetch any Strapi collection entry with the full nested tree, exposing
   * component entities at every nesting level — for any unknown schema depth
   * or field names.
   *
   * @param {string} collection  - Strapi collection plural name (e.g. 'pages', 'articles')
   * @param {object} opts
   * @param {object} [opts.filters]  - Strapi filter fields (e.g. { slug: '/my-page/' })
   * @param {string} [opts.locale]   - Locale code (default: 'en')
   *
   * Three-phase strategy:
   *
   * Phase 1 — Broad populate:
   *   `populate=*` fetches all top-level relations one level deep.
   *   No hardcoded field names — works for any schema.
   *
   * Phase 2 — Iterative stub deepening:
   *   Scans for stub objects (id/documentId only, no content) and re-fetches
   *   with deeper populate params. Merges responses to preserve breadth.
   *   Repeats until no new stubs are found.
   *
   * Component entities are detected by value shape, not by field names.
   */
  async fetchEntry(collection, opts = {}) {
    const { entry } = await this._fetchEntryEnvelope(collection, opts);
    return entry;
  }

  async fetchEntryWithMeta(collection, opts = {}) {
    return this._fetchEntryEnvelope(collection, opts);
  }

  /**
   * Fetch a single nested component entity by documentId with full data.
   *
   * Three-phase strategy:
   *
   * Phase 1 — Broad populate (`populate=*`):
   *   Gets ALL root-level relation fields populated one level deep.
   *   This covers fields OUTSIDE the dynamic zone (e.g. settings, metadata).
   *
   * Phase 2 — Zone populate + Fragment API deepening:
   *   `populate[<componentZoneField>][populate]=*` populates the dynamic zone
   *   one level deeper. Fragment API entries (`[on][uid][populate]...`) then
   *   iteratively deepen within each component type until convergence.
   *
   * Phase 3 — Non-zone iterative deepening:
   *   Scans the ENTIRE entity for remaining stubs/deep paths outside the
   *   dynamic zone. Deepens those via regular populate params. This handles
   *   relations to ANY collection at ANY level — no collection names needed.
   */
  async fetchComponentInstance(documentId, locale = 'en') {
    const ciUrl = `/api/${this.componentCollection}/${documentId}`;

    // ── Phase 1: Broad populate ───────────────────────────────────────────
    const broadRes = await this.http.get(
      `${ciUrl}?${new URLSearchParams([
        ['locale', locale],
        ['populate', '*'],
        this._buildLocalizationPopulateEntry(),
      ])}`
    );
    let data = broadRes.data?.data;
    if (!data) return null;

    // ── Phase 2: Zone populate + Fragment API deepening ───────────────────
    const zonePopulateKey = `populate[${this.schema.componentZoneField}][populate]`;
    const zoneEntries = [
      ['locale', locale],
      [zonePopulateKey, '*'],
      this._buildLocalizationPopulateEntry(),
    ];

    const zoneRes = await this.http.get(
      `${ciUrl}?${new URLSearchParams(zoneEntries)}`
    );
    if (zoneRes.data?.data) data = this._mergeResponses(data, zoneRes.data.data);

    // Fragment API iterative deepening within the dynamic zone
    let allFragKeys = new Set();
    for (let pass = 2; pass <= this.maxPopulatePasses; pass++) {
      const fragEntries = buildFragmentDeepPathEntries(
        data[this.schema.componentZoneField],
        this.schema
      );

      const newEntries = fragEntries.filter(([k]) => !allFragKeys.has(k));
      if (newEntries.length === 0) break;

      for (const [k] of fragEntries) allFragKeys.add(k);

      console.log(
        `[Strapi] Component ${documentId}: fragment pass ${pass} — ${newEntries.length} new path(s)`
      );
      const res = await this.http.get(
        `${ciUrl}?${new URLSearchParams([...zoneEntries, ...fragEntries])}`
      );
      const newData = res.data?.data;
      if (newData) data = this._mergeResponses(data, newData);
    }

    // ── Phase 3: Non-zone iterative deepening ─────────────────────────────
    // Catches any remaining stubs or deep paths across the entire entity,
    // including fields outside the dynamic zone. Uses stopAtEntities: false
    // so populate params traverse through relations to any collection.
    let nonZonePaths = [];
    for (let pass = 0; pass <= this.maxPopulatePasses; pass++) {
      const stubPaths = collectStubPaths(data, { schema: this.schema, stopAtEntities: false });
      const deepPaths = collectDeepPaths(data, { schema: this.schema, stopAtEntities: false });
      const combined = uniquePaths([...stubPaths, ...deepPaths]);

      const prevKeys = new Set(nonZonePaths.map((p) => p.join('\0')));
      const newPaths = combined.filter((p) => !prevKeys.has(p.join('\0')));
      if (newPaths.length === 0) break;

      nonZonePaths = uniquePaths([...nonZonePaths, ...combined]);
      console.log(
        `[Strapi] Component ${documentId}: non-zone pass ${pass + 1} — ${newPaths.length} new path(s)`
      );

      const deepRes = await this.http.get(
        `${ciUrl}?${buildDeepPopulateParams(nonZonePaths, { locale })}`
      );
      const newData = deepRes.data?.data;
      if (!newData) break;
      data = this._mergeResponses(data, newData);
    }

    return data;
  }

  /**
   * Batch fetch multiple component instances in parallel.
   * Returns a map of documentId -> component instance data.
   */
  async fetchComponentInstancesBatch(documentIds, locale = 'en') {
    if (!documentIds.length) return {};

    const fetches = documentIds.map((docId) =>
      this.fetchComponentInstance(docId, locale)
        .then((data) => ({ docId, data, error: null }))
        .catch((err) => ({ docId, data: null, error: err.message }))
    );

    const results = await Promise.all(fetches);

    const map = {};
    for (const { docId, data, error } of results) {
      if (error) {
        console.warn(`[Strapi] Failed to fetch component ${docId}: ${error}`);
        map[docId] = null;
      } else {
        map[docId] = data;
      }
    }
    return map;
  }
}

module.exports = StrapiClient;
