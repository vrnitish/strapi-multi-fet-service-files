const axios = require('axios');
const {
  collectStubPaths,
  collectContainerPaths,
  buildCIPopulateEntries,
  buildDeepPopulateParams,
  buildFragmentDeepEntries,
  buildFragmentCIEntries,
} = require('./deepPopulate');

// Stop the layout scan at component_instance fields.
// The resolver batch-fetches those separately — we only need the stubs.
const CI_STOP_FIELDS = new Set(['component_instance']);

class StrapiClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.timeout = config.timeout || 10000;
    this.maxPopulatePasses = config.maxPopulatePasses || 5;

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
   * Deep-merge CI data into rich page data.
   * Preserves all fields from `rich` and injects `component_instance` values
   * from `ci` only where they are absent in `rich`.
   */
  _mergeCIData(rich, ci) {
    if (!rich || !ci || typeof rich !== 'object' || typeof ci !== 'object') return rich;
    if (Array.isArray(rich)) {
      if (!Array.isArray(ci)) return rich;
      return rich.map((item, i) => this._mergeCIData(item, ci[i] ?? item));
    }
    const result = { ...rich };
    for (const [key, val] of Object.entries(ci)) {
      if (!val) continue;
      if (key === 'component_instance') {
        // Inject only if absent or missing documentId in rich
        if (!rich[key]?.documentId) result[key] = val;
      } else if (typeof val === 'object' && rich[key] && typeof rich[key] === 'object') {
        result[key] = this._mergeCIData(rich[key], val);
      }
    }
    return result;
  }

  /**
   * Fetch a page by slug with the full layout tree, exposing component_instance
   * stubs at every nesting level — for any unknown schema depth or field names.
   *
   * Two-phase strategy:
   *
   * Phase 1 — Iterative stub scan:
   *   Deepens the layout populate pass-by-pass until no more stub objects are
   *   found. This handles intermediate structure that uses RELATIONS (which
   *   Strapi returns as stubs when un-populated).
   *
   * Phase 2 — Absent relation populate:
   *   Strapi OMITS unpopulated relation fields entirely — stubs are never
   *   returned for them, so Phase 1 can't detect them. After Phase 1 reveals
   *   the full container structure, we find every array-of-objects and add
   *   explicit component_instance[fields][0]=documentId populate at each one.
   *   This surfaces the CI stubs the resolver needs, at any nesting level.
   */
  async fetchPageBySlug(slug, locale = 'en') {
    // Passes 2+ use baseOpts (no basePopulateKey) so the accumulated stub paths
    // are the only populate entries — avoids qs conflicts between the parent
    // populate[layout][populate]=* and child populate[layout][populate][X][populate]=*.
    const baseOpts = { slug, locale };
    const firstPassOpts = { ...baseOpts, basePopulateKey: 'populate[layout][populate]' };

    // ── Phase 1: Iterative stub scan ──────────────────────────────────────
    const firstRes = await this.http.get(
      `/api/pages?${buildDeepPopulateParams([], firstPassOpts)}`
    );
    const firstPages = firstRes.data?.data;

    if (!firstPages || firstPages.length === 0) {
      throw new Error(`Page not found for slug: ${slug}`);
    }

    let page = firstPages[0];
    let allStubPaths = [];

    for (let pass = 2; pass <= this.maxPopulatePasses; pass++) {
      const newPaths = collectStubPaths(page, { stopAtFields: CI_STOP_FIELDS });
      if (newPaths.length === 0) break;

      allStubPaths = [...allStubPaths, ...newPaths];
      console.log(`[Strapi] Page pass ${pass}: ${newPaths.length} layout stub(s) — deepening`);

      const deepRes = await this.http.get(
        `/api/pages?${buildDeepPopulateParams(allStubPaths, baseOpts)}`
      );
      const newPages = deepRes.data?.data;
      if (!newPages || newPages.length === 0) break;
      page = newPages[0];
    }

    // ── Phase 2: Expose component_instance stubs at all container levels ──
    // Strapi omits unpopulated relation fields, so we must explicitly ask for
    // component_instance at every container array found in the layout tree.
    const containerPaths = collectContainerPaths(page, { stopAtFields: CI_STOP_FIELDS });
    const ciEntries = buildCIPopulateEntries(containerPaths);

    if (ciEntries.length > 0) {
      console.log(
        `[Strapi] Page CI pass: adding component_instance populate at ${ciEntries.length} container path(s)`
      );
      const ciRes = await this.http.get(
        `/api/pages?${buildDeepPopulateParams(allStubPaths, { ...baseOpts, extraEntries: ciEntries })}`
      );
      const ciPages = ciRes.data?.data;
      if (ciPages && ciPages.length > 0) {
        // Merge CI result into existing page — DO NOT replace outright.
        // The CI pass only fetches component_instance stubs (skipping the
        // full * populate due to qs conflict), so replacing would lose all
        // other field data. Instead, inject only the component_instance
        // values that were absent in `page`.
        page = this._mergeCIData(page, ciPages[0]);
      }
    }

    return page;
  }

  /**
   * Fetch a single component instance by documentId with full data.
   *
   * Three-pass strategy using the Strapi Fragment API to work around the
   * polymorphic restriction on dynamic zones:
   *
   * Pass 1 — `populate[components][populate]=*`
   *   Gets all embedded component data plus shallow stubs for relation fields
   *   (e.g. `layout: [{ id, row_title }]`).
   *
   * Pass 2 — Fragment populate for shallow relations
   *   Detects fields that returned only partial relation objects (few fields)
   *   and re-fetches using `populate[components][on][UID][populate][field]=*`
   *   to get the full relation data (e.g. complete layout rows with columns).
   *
   * Pass 3 — Fragment CI populate for containers
   *   Walks the now-richer data, finds all container arrays, and adds
   *   `populate[components][on][UID][populate][...path...][component_instance]`
   *   entries to surface component_instance stubs at every nesting level.
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

    // ── Pass 2: Fragment populate for shallow relation fields ─────────────
    const deepEntries = buildFragmentDeepEntries(data.components);
    if (deepEntries.length > 0) {
      console.log(
        `[Strapi] Component ${documentId}: fragment-deepening ${deepEntries.length} shallow relation(s)`
      );
      const res2 = await this.http.get(
        `/api/component-instances/${documentId}?${new URLSearchParams([...baseEntries, ...deepEntries])}`
      );
      data = res2.data?.data || data;
    }

    // ── Pass 3: Fragment CI populate for containers ───────────────────────
    const ciEntries = buildFragmentCIEntries(data.components, CI_STOP_FIELDS);
    if (ciEntries.length > 0) {
      console.log(
        `[Strapi] Component ${documentId}: fragment CI populate at ${ciEntries.length} container(s)`
      );
      // Remove deep entries whose key is a strict parent path of any CI entry.
      // Sending populate[X][populate]=* alongside populate[X][populate][Y][...]=v
      // causes a qs type conflict (string vs object on the same key).
      const safeDeepEntries = deepEntries.filter(
        ([dk]) => !ciEntries.some(([ck]) => ck.startsWith(dk + '['))
      );
      try {
        const res3 = await this.http.get(
          `/api/component-instances/${documentId}?${new URLSearchParams([...baseEntries, ...safeDeepEntries, ...ciEntries])}`
        );
        // Merge CI stubs into existing data rather than replacing.
        // Pass 3 may return a thinner response (conflicting deep entries removed),
        // so preserve all rich fields from Pass 2 and only inject absent CI stubs.
        const ciData = res3.data?.data;
        if (ciData) {
          data = this._mergeCIData(data, ciData);
        }
      } catch (err) {
        // Pass 3 fails when CI populate is attempted on arrays that don't have
        // a component_instance field (e.g. menu_list, nav_links). Fall back to
        // Pass 2 data — the component content is intact, just no CI stubs here.
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
