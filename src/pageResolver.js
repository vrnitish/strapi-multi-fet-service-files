/**
 * PageResolver
 *
 * Strategy:
 *   1. Fetch the entry with populate=* + iterative deepening — gets all fields
 *      including null/[] and populates nested relations to full depth.
 *   2. Scan the response for collection relation keys (configured per-collection).
 *      Collect all documentIds grouped by collection.
 *   3. Batch-fetch all unique entities per collection in parallel (each with
 *      populate=* + Fragment API + iterative deepening).
 *   4. Replace stubs with resolved data and recurse — handles any nesting depth.
 *
 * The resolved cache (collection:documentId → data) prevents duplicate fetches
 * and handles circular references safely.
 */

class PageResolver {
  constructor(strapiClient) {
    this.strapi = strapiClient;
    this.schema = {
      entityLabelField: strapiClient?.schema?.entityLabelField || 'component_title',
      localizationField: strapiClient?.schema?.localizationField || 'localizations',
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

  /**
   * Generic entry point — works with any Strapi collection.
   */
  async resolve(collection, filters = {}, locale = 'en') {
    const startTime = Date.now();

    const entry = await this.strapi.fetchEntry(collection, { filters, locale });
    console.log(`[Resolver] ${collection} entry fetched in ${Date.now() - startTime}ms`);

    // cache: "collection:documentId" → fully resolved data
    const cache = {};
    const resolved = await this._deepResolve(entry, locale, cache);

    console.log(
      `[Resolver] Done — ${Object.keys(cache).length} collection relation(s) resolved in ${Date.now() - startTime}ms`
    );
    return resolved;
  }

  async resolveWithMeta(collection, filters = {}, locale = 'en') {
    const startTime = Date.now();

    const { entry, meta } = await this.strapi.fetchEntryWithMeta(collection, {
      filters,
      locale,
    });
    console.log(`[Resolver] ${collection} entry fetched in ${Date.now() - startTime}ms`);

    const cache = {};
    const resolved = await this._deepResolve(entry, locale, cache);

    console.log(
      `[Resolver] Done — ${Object.keys(cache).length} collection relation(s) resolved in ${Date.now() - startTime}ms`
    );
    return {
      data: [resolved],
      meta: meta ?? this._defaultMeta(true),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Recursively resolve all collection relation stubs in `data`.
   *
   * Fetches in waves: scan tree for all collection relations → group by
   * collection → batch-fetch new ones in parallel → replace stubs →
   * recurse into fetched data until no new relations are found.
   */
  async _deepResolve(data, locale, cache) {
    const relations = this.strapi.findCollectionRelations(data);

    // Deduplicate and find only new (unfetched) relations
    const newByCollection = {};
    for (const rel of relations) {
      const cacheKey = `${rel.collection}:${rel.documentId}`;
      if (cacheKey in cache) continue;
      if (!newByCollection[rel.collection]) {
        newByCollection[rel.collection] = new Set();
      }
      newByCollection[rel.collection].add(rel.documentId);
    }

    const collections = Object.keys(newByCollection);
    if (collections.length === 0) {
      return this._replaceCollectionStubs(data, cache);
    }

    const totalNew = collections.reduce((sum, c) => sum + newByCollection[c].size, 0);
    console.log(
      `[Resolver] Fetching ${totalNew} relation(s) across ${collections.length} collection(s): ${collections.map((c) => `${c}(${newByCollection[c].size})`).join(', ')}`
    );

    // Reserve cache slots before async work to prevent duplicate fetches
    for (const collection of collections) {
      for (const docId of newByCollection[collection]) {
        cache[`${collection}:${docId}`] = null;
      }
    }

    // Batch-fetch all collections in parallel
    const batchResults = await Promise.all(
      collections.map(async (collection) => {
        const docIds = [...newByCollection[collection]];
        const map = await this.strapi.fetchBatchByDocumentId(collection, docIds, locale);
        return { collection, map };
      })
    );

    // Recursively resolve each fetched entity
    const resolvePromises = [];
    for (const { collection, map } of batchResults) {
      for (const [docId, rawData] of Object.entries(map)) {
        if (rawData) {
          resolvePromises.push(
            this._deepResolve(rawData, locale, cache).then((resolved) => {
              cache[`${collection}:${docId}`] = resolved;
            })
          );
        }
      }
    }
    await Promise.all(resolvePromises);

    return this._replaceCollectionStubs(data, cache);
  }

  /**
   * Walk the tree and replace every collection relation stub with resolved data.
   *
   * @param {boolean} [insideLocalizations=false] - when true, we're inside a
   *        localization entry — skip nested localizations to prevent infinite loops.
   */
  _replaceCollectionStubs(data, cache, visited, insideLocalizations) {
    visited = visited || new WeakSet();
    insideLocalizations = insideLocalizations || false;
    if (!data || typeof data !== 'object') return data;
    if (visited.has(data)) return data;
    visited.add(data);

    const locField = this.schema.localizationField;
    const collectionKeys = this.strapi.collectionKeys;

    if (Array.isArray(data)) {
      return data.map((item) => this._replaceCollectionStubs(item, cache, visited, insideLocalizations));
    }

    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (value == null || typeof value !== 'object') {
        result[key] = value;
        continue;
      }

      // Localizations: recurse into entries to resolve their collection
      // stubs, but don't recurse into nested localizations (prevents
      // infinite localizations.localizations... chains).
      if (key === locField) {
        if (!insideLocalizations && Array.isArray(value)) {
          result[key] = value.map((item) =>
            this._replaceCollectionStubs(item, cache, visited, true)
          );
        } else {
          result[key] = value;
        }
        continue;
      }

      const collection = collectionKeys[key];

      if (collection && !Array.isArray(value) && value.documentId) {
        // Single collection relation — replace with resolved data
        const cacheKey = `${collection}:${value.documentId}`;
        const resolved = cache[cacheKey];
        result[key] = resolved ?? value;
      } else if (collection && Array.isArray(value)) {
        // Plural collection relation — replace each item
        result[key] = value.map((item) => {
          if (item && typeof item === 'object' && item.documentId) {
            const cacheKey = `${collection}:${item.documentId}`;
            const resolved = cache[cacheKey];
            return resolved ?? item;
          }
          return this._replaceCollectionStubs(item, cache, visited, insideLocalizations);
        });
      } else {
        // Not a collection key — recurse
        result[key] = this._replaceCollectionStubs(value, cache, visited, insideLocalizations);
      }
    }

    return result;
  }
}

module.exports = PageResolver;
