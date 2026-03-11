const axios = require('axios');
const {
  collectStubPaths,
  collectDeepPaths,
  collectContainerPaths,
  uniquePaths,
  buildCIPopulateEntries,
  buildDeepPopulateParams,
  buildFragmentDeepPathEntries,
  buildFragmentCIEntries,
} = require('./deepPopulate');

// Stop the layout scan at component_instance / component_instances fields.
// The resolver batch-fetches those separately — we only need the stubs.
const CI_STOP_FIELDS = new Set(['component_instance', 'component_instances']);

class StrapiClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.timeout = config.timeout || 10000;
    this.maxPopulatePasses = config.maxPopulatePasses || 50;

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

  /**
   * Deep-merge two Strapi responses, preserving the richer version of each field.
   * Used to combine breadth (from populate=*) with depth (from targeted populates)
   * without losing data across passes.
   */
  _mergeResponses(base, update) {
    if (update == null) return base;
    if (base == null) return update;
    if (typeof base !== 'object' || typeof update !== 'object') return update;
    if (Array.isArray(base) || Array.isArray(update)) {
      if (!Array.isArray(base) || !Array.isArray(update)) return update;
      const len = Math.max(base.length, update.length);
      return Array.from({ length: len }, (_, i) =>
        this._mergeResponses(base[i], update[i])
      );
    }
    const result = { ...base };
    for (const [key, val] of Object.entries(update)) {
      if (val == null) continue;
      if (key in result && result[key] != null && typeof result[key] === 'object' && typeof val === 'object') {
        result[key] = this._mergeResponses(result[key], val);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Fetch any Strapi collection entry with the full nested tree, exposing
   * component_instance stubs at every nesting level — for any unknown schema
   * depth or field names.
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
   * Phase 3 — Absent relation populate:
   *   Strapi OMITS unpopulated relation fields entirely — stubs are never
   *   returned for them, so Phase 2 can't detect them. After the full tree
   *   is visible, find every container array and add explicit
   *   component_instance populate to surface CI stubs.
   */
  async fetchEntry(collection, { filters = {}, locale = 'en' } = {}) {
    // ── Phase 1: Broad populate ───────────────────────────────────────────
    const params1 = new URLSearchParams();
    for (const [field, value] of Object.entries(filters)) {
      params1.set(`filters[${field}][$eq]`, value);
    }
    if (locale) params1.set('locale', locale);
    params1.set('populate', '*');

    const firstRes = await this.http.get(`/api/${collection}?${params1}`);
    const firstData = firstRes.data?.data;

    let entry = Array.isArray(firstData) ? firstData[0] : firstData;
    if (!entry) {
      throw new Error(`No entry found in ${collection} with filters: ${JSON.stringify(filters)}`);
    }

    // ── Phase 2: Iterative deepening ─────────────────────────────────────
    // Detects both stubs (under-populated entities) AND real-object arrays
    // whose items may have absent sub-relations. Deepens one level per pass;
    // merge preserves breadth from earlier passes.
    let allPaths = [];
    for (let pass = 2; pass <= this.maxPopulatePasses; pass++) {
      const stubPaths = collectStubPaths(entry, { stopAtFields: CI_STOP_FIELDS });
      const deepPaths = collectDeepPaths(entry, { stopAtFields: CI_STOP_FIELDS });
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

    // ── Phase 3: Expose CI stubs at all container levels ──────────────────
    // After the tree is fully revealed, find non-dynamic-zone containers
    // and add explicit CI populate to surface component_instance stubs.
    const containerPaths = collectContainerPaths(entry, { stopAtFields: CI_STOP_FIELDS });
    const ciEntries = buildCIPopulateEntries(containerPaths);

    if (ciEntries.length > 0) {
      console.log(
        `[Strapi] ${collection} CI pass: adding CI populate at ${ciEntries.length / 2} container path(s)`
      );
      try {
        const ciRes = await this.http.get(
          `/api/${collection}?${buildDeepPopulateParams(allPaths, { locale, filters, extraEntries: ciEntries })}`
        );
        const ciData = ciRes.data?.data;
        const ciEntry = Array.isArray(ciData) ? ciData[0] : ciData;
        if (ciEntry) {
          entry = this._mergeResponses(entry, ciEntry);
        }
      } catch (err) {
        console.warn(
          `[Strapi] ${collection} CI populate skipped (${err.response?.status ?? err.message})`
        );
      }
    }

    return entry;
  }

  /**
   * Fetch a single component instance by documentId with full data.
   *
   * Strategy using the Strapi Fragment API to work around the polymorphic
   * restriction on dynamic zones:
   *
   * Pass 1 — `populate[components][populate]=*`
   *   Gets all embedded component data plus shallow data for relation fields.
   *
   * Iterative Fragment deepening —
   *   Uses collectDeepPaths to find ALL arrays of real objects within each
   *   component type. Builds Fragment API populates for the leaf paths.
   *   Repeats until no new paths appear — handles any nesting depth.
   *   Uses _mergeResponses to preserve data across passes.
   *
   * Fragment CI populate —
   *   Finds all non-dynamic-zone containers and adds explicit
   *   component_instance populate to surface CI stubs.
   *
   * The PageResolver's recursive resolver then batch-fetches all CI stubs.
   */
  async fetchComponentInstance(documentId, locale = 'en') {
    const baseEntries = [
      ['locale', locale],
      ['populate[components][populate]', '*'],
    ];

    // ── Pass 1: Shallow populate ──────────────────────────────────────────
    const res1 = await this.http.get(
      `/api/component-instances/${documentId}?${new URLSearchParams(baseEntries)}`
    );
    let data = res1.data?.data;
    if (!data) return null;

    // ── Iterative Fragment deepening ──────────────────────────────────────
    // Each pass deepens one more level of the component tree via the
    // Fragment API. Detects both stubs AND real objects within each
    // component type. Repeats until no new populate keys are discovered.
    let lastFragEntries = [];
    let allFragKeys = new Set();
    for (let pass = 2; pass <= this.maxPopulatePasses; pass++) {
      const fragEntries = buildFragmentDeepPathEntries(data.components, CI_STOP_FIELDS);

      const newEntries = fragEntries.filter(([k]) => !allFragKeys.has(k));
      if (newEntries.length === 0) break;

      for (const [k] of fragEntries) allFragKeys.add(k);
      lastFragEntries = fragEntries;

      console.log(
        `[Strapi] Component ${documentId}: fragment pass ${pass} — ${newEntries.length} new path(s)`
      );
      const res = await this.http.get(
        `/api/component-instances/${documentId}?${new URLSearchParams([...baseEntries, ...fragEntries])}`
      );
      const newData = res.data?.data;
      if (newData) data = this._mergeResponses(data, newData);
    }

    // ── Fragment CI populate for containers ───────────────────────────────
    const ciEntries = buildFragmentCIEntries(data.components, CI_STOP_FIELDS);
    if (ciEntries.length > 0) {
      console.log(
        `[Strapi] Component ${documentId}: fragment CI populate at ${ciEntries.length / 2} container(s)`
      );
      // Remove fragment entries whose key is a strict parent of any CI entry.
      const safeFragEntries = lastFragEntries.filter(
        ([dk]) => !ciEntries.some(([ck]) => ck.startsWith(dk + '['))
      );
      try {
        const res = await this.http.get(
          `/api/component-instances/${documentId}?${new URLSearchParams([...baseEntries, ...safeFragEntries, ...ciEntries])}`
        );
        const ciData = res.data?.data;
        if (ciData) {
          data = this._mergeResponses(data, ciData);
        }
      } catch (err) {
        console.warn(
          `[Strapi] Component ${documentId}: CI populate skipped (${err.response?.status ?? err.message})`
        );
      }
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
