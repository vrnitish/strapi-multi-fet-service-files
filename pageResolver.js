/**
 * PageResolver
 *
 * Strategy:
 * 1. Fetch page shell (layout rows/cols with embedded component_instance stubs)
 *    — Strapi already returns this in one query since layout is a component (not a relation)
 * 2. Walk the layout tree to collect all component_instance documentIds
 * 3. Batch-fetch all component instances IN PARALLEL (same depth level together)
 * 4. For any fetched instance that is a composition-wrapper (has inner layout),
 *    collect the inner component_instance documentIds and batch-fetch those in parallel
 * 5. Reassemble the full resolved tree matching the original response shape
 *    so Next.js needs zero changes
 */

const WRAPPER_COMPONENT = 'components.composition-wrapper';

class PageResolver {
  constructor(strapiClient, options = {}) {
    this.strapi = strapiClient;
    this.maxDepth = options.maxDepth || 5;
  }

  /**
   * Main entry point.
   * Returns a page object with the same shape as the original deep Strapi response,
   * but assembled via parallel flat fetches instead of recursive populate.
   */
  async resolvePage(slug, locale = 'en') {
    const startTime = Date.now();

    // ── Step 1: Fetch page shell ──────────────────────────────────────────────
    // layout[] is a Strapi component (not a relation), so Strapi returns it
    // inline with populate=layout. No depth issue here.
    const page = await this.strapi.fetchPageBySlug(slug, locale);
    console.log(`[Resolver] Page shell fetched in ${Date.now() - startTime}ms`);

    // ── Step 2: Collect all level-1 component_instance stubs ─────────────────
    // These are the component_instances sitting directly inside page.layout cols
    const level1Stubs = this._collectInstanceStubs(page.layout || []);
    console.log(`[Resolver] Found ${level1Stubs.length} level-1 component instances`);

    // ── Step 3: Batch-fetch all level-1 instances IN PARALLEL ────────────────
    const level1DocIds = level1Stubs.map((s) => s.documentId);
    const level1Map = await this.strapi.fetchComponentInstancesBatch(
      level1DocIds,
      locale
    );
    console.log(`[Resolver] Level-1 batch fetched in ${Date.now() - startTime}ms`);

    // ── Step 4: Find any composition-wrappers among level-1, collect level-2 ─
    const level2Stubs = this._collectInnerStubs(level1Map);
    console.log(`[Resolver] Found ${level2Stubs.length} level-2 component instances`);

    let level2Map = {};
    if (level2Stubs.length > 0) {
      const level2DocIds = level2Stubs.map((s) => s.documentId);
      level2Map = await this.strapi.fetchComponentInstancesBatch(
        level2DocIds,
        locale
      );
      console.log(`[Resolver] Level-2 batch fetched in ${Date.now() - startTime}ms`);
    }

    // ── Step 5: Reassemble the full tree ─────────────────────────────────────
    const resolvedPage = this._assemblePage(page, level1Map, level2Map);
    console.log(`[Resolver] Total resolution time: ${Date.now() - startTime}ms`);

    return resolvedPage;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE: Tree traversal helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Walk page.layout[] → rows → columns and collect every component_instance stub.
   * Returns array of { documentId, id, _path } for tracking.
   *
   * NOTE: The stub already contains the documentId — Strapi embeds it inline
   * even at shallow populate depth. We use this to fetch the full data.
   */
  _collectInstanceStubs(layoutRows) {
    const stubs = [];

    for (const row of layoutRows) {
      for (const col of row.columns || []) {
        const ci = col.component_instance;
        if (ci?.documentId) {
          stubs.push({
            id: ci.id,
            documentId: ci.documentId,
          });
        }
      }
    }

    return stubs;
  }

  /**
   * Given the map of fetched level-1 component instances,
   * find those that are composition-wrappers and collect their inner CI stubs.
   */
  _collectInnerStubs(instanceMap) {
    const stubs = [];

    for (const [, instance] of Object.entries(instanceMap)) {
      if (!instance) continue;

      const components = instance.components || [];
      for (const comp of components) {
        if (comp.__component === WRAPPER_COMPONENT) {
          // This is a wrapper — it has its own inner layout
          const innerStubs = this._collectInstanceStubs(comp.layout || []);
          stubs.push(...innerStubs);
        }
      }
    }

    // Deduplicate by documentId (a component instance may appear in multiple wrappers)
    const seen = new Set();
    return stubs.filter(({ documentId }) => {
      if (seen.has(documentId)) return false;
      seen.add(documentId);
      return true;
    });
  }

  /**
   * Reassemble the full page tree, substituting stub component_instances
   * with fully-fetched data. Preserves the original response shape exactly.
   */
  _assemblePage(page, level1Map, level2Map) {
    const resolvedLayout = (page.layout || []).map((row) => ({
      ...row,
      columns: (row.columns || []).map((col) => ({
        ...col,
        component_instance: col.component_instance
          ? this._resolveInstance(
              col.component_instance,
              level1Map,
              level2Map
            )
          : null,
      })),
    }));

    return {
      ...page,
      layout: resolvedLayout,
    };
  }

  /**
   * Resolve a single component instance stub into full data.
   * If it's a wrapper, also resolve its inner component instances.
   */
  _resolveInstance(stub, level1Map, level2Map) {
    const full = level1Map[stub.documentId];

    if (!full) {
      // Fetch failed or not found — return stub as-is so page doesn't break
      console.warn(`[Resolver] Missing data for component: ${stub.documentId}`);
      return stub;
    }

    // Resolve inner components if this is a wrapper
    const resolvedComponents = (full.components || []).map((comp) => {
      if (comp.__component !== WRAPPER_COMPONENT) {
        return comp; // Leaf component — return as-is
      }

      // Composition wrapper — resolve its inner layout
      return {
        ...comp,
        layout: (comp.layout || []).map((innerRow) => ({
          ...innerRow,
          columns: (innerRow.columns || []).map((innerCol) => ({
            ...innerCol,
            component_instance: innerCol.component_instance
              ? this._resolveInnerInstance(innerCol.component_instance, level2Map)
              : null,
          })),
        })),
      };
    });

    return {
      ...full,
      components: resolvedComponents,
    };
  }

  /**
   * Resolve a level-2 (inner wrapper) component instance stub.
   */
  _resolveInnerInstance(stub, level2Map) {
    const full = level2Map[stub.documentId];

    if (!full) {
      console.warn(
        `[Resolver] Missing inner component data for: ${stub.documentId}`
      );
      return stub;
    }

    return full;
  }
}

module.exports = PageResolver;
