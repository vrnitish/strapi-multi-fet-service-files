/**
 * PageResolver
 *
 * Strategy:
 * 1. Fetch the page shell — layout tree iteratively deepened until
 *    component_instance stubs are visible at every level.
 * 2. Recursively resolve ALL component_instance stubs in the tree:
 *    - Find all stubs not yet fetched
 *    - Batch-fetch them in parallel
 *    - Recursively resolve stubs inside each fetched instance
 *    - Repeat until no stubs remain (handles any nesting depth)
 * 3. Replace every stub with its fully-resolved data.
 *
 * The resolved cache (documentId → data) prevents duplicate fetches and
 * handles circular references safely.
 */

class PageResolver {
  constructor(strapiClient, options = {}) {
    this.strapi = strapiClient;
  }

  /**
   * Main entry point.
   */
  async resolvePage(slug, locale = 'en') {
    const startTime = Date.now();

    const page = await this.strapi.fetchPageBySlug(slug, locale);
    console.log(`[Resolver] Page shell fetched in ${Date.now() - startTime}ms`);

    // cache: documentId → fully resolved instance data (null = fetch failed)
    const cache = {};
    const resolvedPage = await this._deepResolve(page, locale, cache);

    console.log(
      `[Resolver] Done — ${Object.keys(cache).length} component instance(s) resolved in ${Date.now() - startTime}ms`
    );
    return resolvedPage;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Recursively resolve all component_instance stubs in `data`.
   * Fetches in waves: collect all new stubs → batch-fetch → recurse into
   * each fetched instance → replace. Repeats until no new stubs are found.
   *
   * @param {*}      data   - any Strapi response fragment
   * @param {string} locale
   * @param {object} cache  - shared documentId → resolved data map
   */
  async _deepResolve(data, locale, cache) {
    const stubs = this._findAllCIStubs(data);
    const newIds = [...new Set(stubs.map((s) => s.documentId))].filter(
      (id) => !(id in cache)
    );

    if (newIds.length === 0) {
      return this._replaceCIStubs(data, cache);
    }

    console.log(`[Resolver] Fetching ${newIds.length} component instance(s)`);

    // Reserve cache slots before async work to prevent duplicate fetches
    // in concurrent recursive calls (same id found in multiple branches).
    for (const id of newIds) cache[id] = null;

    const rawMap = await this.strapi.fetchComponentInstancesBatch(newIds, locale);

    // Recursively resolve each fetched instance before inserting into cache.
    // This handles nested CIs at any depth.
    await Promise.all(
      newIds.map(async (id) => {
        if (rawMap[id]) {
          cache[id] = await this._deepResolve(rawMap[id], locale, cache);
        }
      })
    );

    return this._replaceCIStubs(data, cache);
  }

  /**
   * Walk the tree and collect every { documentId, ... } object found under
   * a key named "component_instance". Does not recurse into those objects.
   */
  _findAllCIStubs(data, visited = new WeakSet()) {
    if (!data || typeof data !== 'object') return [];
    if (visited.has(data)) return [];
    visited.add(data);

    const stubs = [];

    if (Array.isArray(data)) {
      for (const item of data) {
        stubs.push(...this._findAllCIStubs(item, visited));
      }
      return stubs;
    }

    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object') continue;
      if (key === 'component_instance' && value.documentId) {
        stubs.push(value);
      } else {
        stubs.push(...this._findAllCIStubs(value, visited));
      }
    }

    return stubs;
  }

  /**
   * Walk the tree and replace every component_instance stub with the
   * resolved data from cache. Falls back to the original stub on failure.
   */
  _replaceCIStubs(data, cache, visited = new WeakSet()) {
    if (!data || typeof data !== 'object') return data;
    if (visited.has(data)) return data;
    visited.add(data);

    if (Array.isArray(data)) {
      return data.map((item) => this._replaceCIStubs(item, cache, visited));
    }

    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'component_instance' && value?.documentId) {
        const resolved = cache[value.documentId];
        if (resolved == null) {
          console.warn(`[Resolver] Missing data for component: ${value.documentId}`);
        }
        result[key] = resolved ?? value;
      } else if (value && typeof value === 'object') {
        result[key] = this._replaceCIStubs(value, cache, visited);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}

module.exports = PageResolver;
