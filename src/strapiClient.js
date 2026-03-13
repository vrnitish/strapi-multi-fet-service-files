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
    // Pre-seed from config if provided (bypasses /api/i18n/locales call)
    this._localesCache = Array.isArray(config.locales) && config.locales.length > 0
      ? config.locales
      : null;
    this._localesFetch = null;  // in-flight promise (prevents parallel duplicate requests)

    // Collection keys: maps field names → collection plural API names
    // e.g. { 'component_instance': 'component-instances', 'user_types': 'user-types' }
    this.collectionKeys = config.collectionKeys || {};

    // Fields to always explicitly populate even when null.
    // Strapi REST API omits optional null fields from populate=* responses;
    // listing them here forces a dedicated request so they appear as null.
    this.alwaysPopulateFields = config.alwaysPopulateFields || [];

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

  // ─────────────────────────────────────────────────────────────────────────
  // i18n — locale discovery
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch all locale codes configured in Strapi via the i18n plugin API.
   * Result is cached for the lifetime of the client instance.
   *
   * In Strapi v5 the `localizations` field is often absent from REST responses
   * even with populate=*. The reliable approach is to query all available
   * locales and fetch each one directly with the `locale` param.
   */
  async _fetchLocales() {
    if (this._localesCache !== null) return this._localesCache;
    // Share a single in-flight promise so concurrent calls don't race
    if (!this._localesFetch) {
      this._localesFetch = this.http.get('/api/i18n/locales')
        .then((res) => {
          this._localesCache = (res.data || []).map((l) => l.code);
          console.log(`[Strapi] i18n locales: [${this._localesCache.join(', ')}]`);
          return this._localesCache;
        })
        .catch((err) => {
          console.error(
            `[Strapi] Failed to fetch i18n locales: ${err.response?.status ?? err.message}. ` +
            `Localizations will not be populated. ` +
            `Ensure the API token has i18n > Locale > find permission in Strapi Admin.`
          );
          this._localesCache = [];
          return this._localesCache;
        });
    }
    return this._localesFetch;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Page/entry fetch — populate=* + iterative deepening
  // ─────────────────────────────────────────────────────────────────────────

  async _fetchEntryEnvelope(collection, { filters = {}, locale = 'en' } = {}) {
    let meta;

    // Phase 1: populate=* — gets ALL fields (including null/[]) one level deep
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

    // Phase 1b: explicitly fetch any always-populate fields missing from entry.
    // Strapi omits optional null fields (e.g. seo_elements: null) from populate=*
    // responses. A dedicated request with explicit populate params forces them back.
    const missingAlways = this.alwaysPopulateFields.filter((f) => !(f in entry));
    if (missingAlways.length > 0) {
      const p1bParams = new URLSearchParams();
      for (const [field, value] of Object.entries(filters)) {
        p1bParams.set(`filters[${field}][$eq]`, value);
      }
      if (locale) p1bParams.set('locale', locale);
      for (const f of missingAlways) p1bParams.set(`populate[${f}][populate]`, '*');
      const p1bRes = await this.http.get(`/api/${collection}?${p1bParams}`).catch(() => null);
      const p1bData = p1bRes?.data?.data;
      const p1bEntry = Array.isArray(p1bData) ? p1bData[0] : p1bData;
      if (p1bEntry) entry = this._mergeResponses(entry, p1bEntry);
    }

    // Save Phase 1 localizations — deepening requests use specific populate
    // params instead of populate=* and Strapi returns localizations: [] for
    // those, which would overwrite the populated data via _mergeResponses.
    const locField = this.schema.localizationField;
    const phase1Localizations = entry[locField];

    // Phase 2: Iterative deepening — deepen non-collection-key paths
    // stopAtEntities: false — traverse through all relations to expose
    // collection relation stubs at any depth. The resolver handles them.
    let allPaths = [];
    for (let pass = 2; pass <= this.maxPopulatePasses; pass++) {
      const stubPaths = collectStubPaths(entry, { schema: this.schema, stopAtEntities: false });
      const deepPaths = collectDeepPaths(entry, { schema: this.schema, stopAtEntities: false });
      const combined = uniquePaths([...stubPaths, ...deepPaths]);

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

      // Restore localizations if a deepening pass overwrote them with []
      if (
        phase1Localizations &&
        Array.isArray(phase1Localizations) &&
        phase1Localizations.length > 0 &&
        (!entry[locField] || (Array.isArray(entry[locField]) && entry[locField].length === 0))
      ) {
        entry[locField] = phase1Localizations;
      }
    }

    // Phase 3: Populate localization entries.
    // Strapi v5 often returns localizations:[] even when localized versions
    // exist (https://forum.strapi.io/t/v5-localizations/40283). Instead of
    // relying on the field, we query /api/i18n/locales for the full locale
    // list and fetch the entry in each other locale directly.
    if (entry.documentId) {
      const allLocales = await this._fetchLocales();
      const otherLocales = allLocales.filter((l) => l !== locale);

      if (otherLocales.length > 0) {
        console.log(
          `[Strapi] ${collection}: fetching ${otherLocales.length} locale(s) for documentId ${entry.documentId}`
        );

        const locResults = await Promise.all(
          otherLocales.map((loc) =>
            this.fetchByDocumentId(collection, entry.documentId, loc, {
              resolveLocalizations: false,
            })
              .then((d) => d || null)
              .catch(() => null)
          )
        );

        const populated = locResults.filter(Boolean);
        if (populated.length > 0) {
          entry[locField] = populated;
        }
      }
    }

    return { entry, meta };
  }

  async fetchEntry(collection, opts = {}) {
    const { entry } = await this._fetchEntryEnvelope(collection, opts);
    return entry;
  }

  async fetchEntryWithMeta(collection, opts = {}) {
    return this._fetchEntryEnvelope(collection, opts);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection entity fetch — populate=* + zone deepening + Fragment API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch a single collection entity by documentId with full deep data.
   *
   * Phase 1: populate=* — all root-level fields populated one level.
   * Phase 2: Zone populate + Fragment API iterative deepening for dynamic zones.
   * Phase 3: Non-zone iterative deepening for remaining stubs/deep paths.
   * Phase 4: Populate each localization entry with its own full deep data.
   *
   * @param {boolean} [opts.resolveLocalizations=true] - set to false to skip
   *        Phase 4 (prevents infinite recursion when fetching localization entries)
   */
  async fetchByDocumentId(collection, documentId, locale = 'en', { resolveLocalizations = true } = {}) {
    const url = `/api/${collection}/${documentId}`;

    // ── Phase 1: populate=* ───────────────────────────────────────────────────
    const broadRes = await this.http.get(
      `${url}?${new URLSearchParams([['locale', locale], ['populate', '*']])}`
    );
    let data = broadRes.data?.data;
    if (!data) return null;

    // ── Phase 1b: explicitly fetch any always-populate fields missing from data ──
    const missingAlwaysCI = this.alwaysPopulateFields.filter((f) => !(f in data));
    if (missingAlwaysCI.length > 0) {
      const p1bEntries = [['locale', locale], ...missingAlwaysCI.map((f) => [`populate[${f}][populate]`, '*'])];
      const p1bRes = await this.http.get(`${url}?${new URLSearchParams(p1bEntries)}`).catch(() => null);
      if (p1bRes?.data?.data) data = this._mergeResponses(data, p1bRes.data.data);
    }

    // ── Phase 2: Zone populate + Fragment API deepening ───────────────────
    const zoneField = this.schema.componentZoneField;
    const locField = this.schema.localizationField;

    // Track the best-known localizations across all deepening phases.
    // Strapi returns localizations: [] on any request that uses specific
    // populate params instead of populate=*, so every merge can wipe them.
    // We restore after every merge that empties the array.
    let savedLocalizations = data[locField];

    const _restoreLocalizations = () => {
      if (
        savedLocalizations &&
        Array.isArray(savedLocalizations) &&
        savedLocalizations.length > 0 &&
        (!data[locField] || (Array.isArray(data[locField]) && data[locField].length === 0))
      ) {
        data[locField] = savedLocalizations;
      }
    };

    if (data[zoneField] !== undefined) {
      const zonePopulateKey = `populate[${zoneField}][populate]`;
      const zoneEntries = [
        ['locale', locale],
        [zonePopulateKey, '*'],
      ];

      const zoneRes = await this.http.get(
        `${url}?${new URLSearchParams(zoneEntries)}`
      );
      if (zoneRes.data?.data) {
        data = this._mergeResponses(data, zoneRes.data.data);
        _restoreLocalizations();
      }

      // Fragment API iterative deepening within the dynamic zone
      let allFragKeys = new Set();
      for (let pass = 2; pass <= this.maxPopulatePasses; pass++) {
        const fragEntries = buildFragmentDeepPathEntries(
          data[zoneField],
          this.schema
        );

        const newEntries = fragEntries.filter(([k]) => !allFragKeys.has(k));
        if (newEntries.length === 0) break;

        for (const [k] of fragEntries) allFragKeys.add(k);

        console.log(
          `[Strapi] ${collection}/${documentId}: fragment pass ${pass} — ${newEntries.length} new path(s)`
        );
        const res = await this.http.get(
          `${url}?${new URLSearchParams([...zoneEntries, ...fragEntries])}`
        );
        const newData = res.data?.data;
        if (newData) {
          data = this._mergeResponses(data, newData);
          _restoreLocalizations();
        }
      }
    }

    // ── Phase 3: Non-zone iterative deepening ─────────────────────────────
    // Catches remaining stubs or deep paths across the entire entity.
    // stopAtEntities: false so populate params traverse through all relations.
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
        `[Strapi] ${collection}/${documentId}: non-zone pass ${pass + 1} — ${newPaths.length} new path(s)`
      );

      const deepRes = await this.http.get(
        `${url}?${buildDeepPopulateParams(nonZonePaths, { locale })}`
      );
      const newData = deepRes.data?.data;
      if (!newData) break;
      data = this._mergeResponses(data, newData);
      _restoreLocalizations();
    }

    // ── Phase 4: Populate localization entries ──────────────────────────
    // Strapi v5 often returns localizations:[] even when localized versions
    // exist (https://forum.strapi.io/t/v5-localizations/40283). Instead of
    // relying on the field, query /api/i18n/locales for all locale codes and
    // fetch this entity in each other locale directly.
    if (resolveLocalizations) {
      const allLocales = await this._fetchLocales();
      const otherLocales = allLocales.filter((l) => l !== locale);

      if (otherLocales.length > 0) {
        console.log(
          `[Strapi] ${collection}/${documentId}: fetching ${otherLocales.length} locale(s)`
        );

        const locResults = await Promise.all(
          otherLocales.map((loc) =>
            this.fetchByDocumentId(collection, documentId, loc, {
              resolveLocalizations: false,
            })
              .then((d) => d || null)
              .catch(() => null)
          )
        );

        const populated = locResults.filter(Boolean);
        if (populated.length > 0) {
          data[locField] = populated;
        }
      }
    }

    return data;
  }

  /**
   * Batch fetch multiple entries from the same collection in parallel.
   * Returns a map of documentId → entry data.
   */
  async fetchBatchByDocumentId(collection, documentIds, locale = 'en') {
    if (!documentIds.length) return {};

    const fetches = documentIds.map((docId) =>
      this.fetchByDocumentId(collection, docId, locale)
        .then((data) => ({ docId, data, error: null }))
        .catch((err) => ({ docId, data: null, error: err.message }))
    );

    const results = await Promise.all(fetches);

    const map = {};
    for (const { docId, data, error } of results) {
      if (error) {
        console.warn(`[Strapi] Failed to fetch ${collection}/${docId}: ${error}`);
        map[docId] = null;
      } else {
        map[docId] = data;
      }
    }
    return map;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection relation scanning
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Scan a data tree for all collection relation references.
   * Returns: Array of { field, collection, documentId }
   *
   * @param {boolean} [insideLocalizations=false] - when true, we're already
   *        inside a localizations entry — skip nested localizations to prevent
   *        infinite recursion.
   */
  findCollectionRelations(data, visited, insideLocalizations) {
    visited = visited || new WeakSet();
    insideLocalizations = insideLocalizations || false;
    if (!data || typeof data !== 'object') return [];
    if (visited.has(data)) return [];
    visited.add(data);

    const relations = [];
    const locField = this.schema.localizationField;

    if (Array.isArray(data)) {
      for (const item of data) {
        relations.push(...this.findCollectionRelations(item, visited, insideLocalizations));
      }
      return relations;
    }

    for (const [key, value] of Object.entries(data)) {
      if (value == null) continue;

      // Localizations: recurse into the entries to find their collection
      // relations, but never recurse into nested localizations (prevents
      // infinite localizations.localizations... chains).
      if (key === locField) {
        if (!insideLocalizations && Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object') {
              relations.push(...this.findCollectionRelations(item, visited, true));
            }
          }
        }
        continue;
      }

      const collection = this.collectionKeys[key];

      if (collection && typeof value === 'object' && !Array.isArray(value) && value.documentId) {
        relations.push({ field: key, collection, documentId: value.documentId });
        relations.push(...this.findCollectionRelations(value, visited, insideLocalizations));
      } else if (collection && Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && item.documentId) {
            relations.push({ field: key, collection, documentId: item.documentId });
            relations.push(...this.findCollectionRelations(item, visited, insideLocalizations));
          }
        }
      } else if (typeof value === 'object') {
        relations.push(...this.findCollectionRelations(value, visited, insideLocalizations));
      }
    }

    return relations;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Response merging
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deep-merge two Strapi responses.
   * Keeps earlier data only when the newer payload omits a key entirely.
   * Explicit newer values such as null and [] must win.
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
}

module.exports = StrapiClient;
