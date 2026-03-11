/**
 * PageResolver
 *
 * Strategy:
 * 1. Fetch the page shell — layout tree iteratively deepened until
 *    component entities are visible at every level.
 * 2. Recursively resolve all component entities in the tree:
 *    - Detect them by shape, not relation field name
 *    - Batch-fetch them in parallel
 *    - Recursively resolve entities inside each fetched instance
 *    - Repeat until no new entities remain (handles any nesting depth)
 * 3. Replace every entity with its fully-resolved data.
 *
 * The resolved cache (documentId → data) prevents duplicate fetches and
 * handles circular references safely.
 */

class PageResolver {
  constructor(strapiClient, config = {}) {
    this.strapi = strapiClient;
    this.schema = {
      entityLabelField:
        config.entityLabelField ||
        strapiClient?.schema?.entityLabelField ||
        'component_title',
      localizationField:
        config.localizationField ||
        strapiClient?.schema?.localizationField ||
        'localizations',
    };
  }

  _defaultMeta(hasEntry = true) {
    return {
      pagination: {
        page: 1,
        pageCount: hasEntry ? 1 : 0,
        pageSize: hasEntry ? 1 : 0,
        total: hasEntry ? 1 : 0,
      },
    };
  }

  async _resolveEntry(entry, collection, locale, startTime) {
    // cache: documentId → fully resolved instance data (null = fetch failed)
    const cache = {};
    const resolved = await this._deepResolve(entry, locale, cache);

    console.log(
      `[Resolver] Done — ${Object.keys(cache).length} component instance(s) resolved in ${Date.now() - startTime}ms`
    );
    return resolved;
  }

  /**
   * Generic entry point — works with any Strapi collection.
   *
   * @param {string} collection - Strapi collection plural name (e.g. 'pages', 'articles')
   * @param {object} filters    - Strapi filter fields (e.g. { slug: '/my-page/' })
   * @param {string} locale     - Locale code (default: 'en')
   */
  async resolve(collection, filters = {}, locale = 'en') {
    const startTime = Date.now();

    const entry = await this.strapi.fetchEntry(collection, { filters, locale });
    console.log(`[Resolver] ${collection} entry fetched in ${Date.now() - startTime}ms`);
    return this._resolveEntry(entry, collection, locale, startTime);
  }

  async resolveWithMeta(collection, filters = {}, locale = 'en') {
    const startTime = Date.now();

    const { entry, meta } = await this.strapi.fetchEntryWithMeta(collection, {
      filters,
      locale,
    });
    console.log(`[Resolver] ${collection} entry fetched in ${Date.now() - startTime}ms`);

    const resolved = await this._resolveEntry(entry, collection, locale, startTime);
    return {
      data: [resolved],
      meta: meta ?? this._defaultMeta(true),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if `obj` looks like a resolvable component entity.
   * Detection is shape-based using configurable schema hints, not key-based.
   */
  _isCIEntity(obj) {
    return (
      obj != null &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      typeof obj.documentId === 'string' &&
      this.schema.entityLabelField in obj
    );
  }

  /**
   * Recursively resolve all component entities in `data`.
   * Fetches in waves: collect all new entities → batch-fetch → recurse into
   * each fetched instance → replace. Repeats until no new entities are found.
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
   * Walk the tree and collect every resolvable component entity.
   * Detects by shape using configurable schema hints — works for any field name.
   * Does not recurse into found entities — the resolver re-fetches them fully.
   */
  _findAllCIStubs(data, visited = new WeakSet()) {
    if (!data || typeof data !== 'object') return [];
    if (visited.has(data)) return [];
    visited.add(data);

    const stubs = [];

    if (Array.isArray(data)) {
      for (const item of data) {
        if (this._isCIEntity(item)) {
          stubs.push(item);
        } else {
          stubs.push(...this._findAllCIStubs(item, visited));
        }
      }
      return stubs;
    }

    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object') continue;
      if (key === this.schema.localizationField) continue;

      if (this._isCIEntity(value)) {
        stubs.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (this._isCIEntity(item)) {
            stubs.push(item);
          } else if (item && typeof item === 'object') {
            stubs.push(...this._findAllCIStubs(item, visited));
          }
        }
      } else {
        stubs.push(...this._findAllCIStubs(value, visited));
      }
    }

    return stubs;
  }

  /**
   * Walk the tree and replace every resolved component entity with the
   * resolved data from cache. Falls back to the original on failure.
   * Detection is shape-based using configurable schema hints.
   */
  _replaceCIStubs(data, cache, visited = new WeakSet()) {
    if (!data || typeof data !== 'object') return data;
    if (visited.has(data)) return data;
    visited.add(data);

    if (Array.isArray(data)) {
      return data.map((item) => {
        if (this._isCIEntity(item)) {
          const resolved = cache[item.documentId];
          if (resolved == null) {
            console.warn(`[Resolver] Missing data for component: ${item.documentId}`);
          }
          return resolved ?? item;
        }
        return this._replaceCIStubs(item, cache, visited);
      });
    }

    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object') {
        result[key] = value;
        continue;
      }

      if (key === this.schema.localizationField) {
        result[key] = value;
        continue;
      }

      if (this._isCIEntity(value)) {
        const resolved = cache[value.documentId];
        if (resolved == null) {
          console.warn(`[Resolver] Missing data for component: ${value.documentId}`);
        }
        result[key] = resolved ?? value;
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) => {
          if (this._isCIEntity(item)) {
            const resolved = cache[item.documentId];
            if (resolved == null) {
              console.warn(`[Resolver] Missing data for component: ${item.documentId}`);
            }
            return resolved ?? item;
          }
          return this._replaceCIStubs(item, cache, visited);
        });
      } else {
        result[key] = this._replaceCIStubs(value, cache, visited);
      }
    }

    return result;
  }
}

module.exports = PageResolver;
