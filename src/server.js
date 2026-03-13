/**
 * Strapi Page Resolver — Express HTTP Server
 *
 * Routes mirror Strapi's native REST API — use this service as a drop-in replacement:
 *   GET  /api/:collection/:documentId?...  → Single document by documentId
 *   GET  /api/:collection?...              → Filtered entry (or list all)
 *   POST /webhook/strapi                   → Cache invalidation on publish
 *   GET  /health                           → Health check
 */

const express = require('express');
const StrapiClient = require('./strapiClient');
const PageResolver = require('./pageResolver');
const CacheManager = require('./cacheManager');

function createServer(config) {
  const app = express();
  app.use(express.json());

  // ── Initialise dependencies ────────────────────────────────────────────────
  const strapiClient = new StrapiClient({
    baseUrl: config.strapiUrl,
    token: config.strapiToken,
    timeout: config.strapiTimeout || 10000,
    collectionKeys: config.collectionKeys || {},
    componentCollection: config.componentCollection,
    componentZoneField: config.componentZoneField,
    componentTypeField: config.componentTypeField,
    entityLabelField: config.entityLabelField,
    localizationField: config.localizationField,
    locales: config.locales || null,
    alwaysPopulateFields: config.alwaysPopulateFields || [],
  });

  const resolver = new PageResolver(strapiClient);

  // Pre-fetch locales at startup so any permission error is visible immediately
  strapiClient._fetchLocales();

  const cache = new CacheManager({
    enabled: config.cacheEnabled !== false,
    redisUrl: config.redisUrl,
    ttl: config.cacheTtl || 300,
  });

  // ── Routes ─────────────────────────────────────────────────────────────────

  /**
   * GET /health
   * Must be registered before /:collection to avoid being caught by it.
   */
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  /**
   * GET /api/:collection/:documentId?locale=en&depth=1
   * Drop-in replacement for Strapi's /api/:collection/:documentId endpoint.
   * If populate is present, proxies directly to Strapi.
   * Otherwise uses depth pipeline.
   *
   * Examples:
   *   GET /api/pages/pc3advehph0ewmqh8lnoa0uu
   *   GET /api/pages/pc3advehph0ewmqh8lnoa0uu?locale=hi
   *   GET /api/pages/pc3advehph0ewmqh8lnoa0uu?depth=full
   *   GET /api/pages/pc3advehph0ewmqh8lnoa0uu?populate=*
   */
  app.get('/api/:collection/:documentId', async (req, res) => {
    const { collection } = req.params;
    const documentId = req.params.documentId.replace(/\/$/, '');
    const locale = req.query.locale || 'en';

    // Raw query string without 'depth' (our custom param)
    const rawQsFull = req.url.includes('?') ? req.url.split('?').slice(1).join('?') : '';
    const rawQuery = rawQsFull.replace(/(?:^|&)depth=[^&]*/g, '').replace(/^&/, '');

    // If populate present, proxy directly to Strapi
    const hasPopulate = 'populate' in req.query;
    if (hasPopulate) {
      try {
        const response = await strapiClient.proxyGet(`/api/${collection}/${documentId}`, rawQuery);
        return res.json(response);
      } catch (err) {
        const strapiStatus = err.response?.status;
        const strapiBody = err.response?.data;
        console.error(`[Server] Proxy error ${collection}/${documentId}:`, err.message, strapiBody ? JSON.stringify(strapiBody) : '');
        if (strapiStatus) return res.status(strapiStatus).json(strapiBody);
        return res.status(502).json({ error: 'Upstream unreachable', message: err.message });
      }
    }

    const { depth = '1' } = req.query;
    let maxDepth;
    if (depth === 'full') {
      maxDepth = Infinity;
    } else {
      const parsed = parseInt(depth, 10);
      if (isNaN(parsed) || parsed < 1 || String(parsed) !== String(depth)) {
        return res.status(400).json({ error: 'depth must be a positive integer or "full"' });
      }
      maxDepth = parsed;
    }

    try {
      const cacheKey = `${collection}:${documentId}:${rawQuery}`;
      const cached = await cache.get(cacheKey, locale);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(Array.isArray(cached?.data) ? cached : { data: cached });
      }

      res.set('X-Cache', 'MISS');
      const response = await resolver.resolveById(collection, documentId, locale, { maxDepth, rawQuery });
      if (!response) {
        return res.status(404).json({ error: `${collection} ${documentId} not found` });
      }
      await cache.set(cacheKey, locale, response);
      return res.json(response);
    } catch (err) {
      const strapiStatus = err.response?.status;
      const strapiBody = err.response?.data;
      console.error(
        `[Server] Error resolving ${collection}/${documentId}:`,
        err.message,
        strapiBody ? JSON.stringify(strapiBody) : ''
      );

      if (strapiStatus) return res.status(strapiStatus).json(strapiBody);
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/:collection?<filters>&locale=en
   * Drop-in replacement for Strapi's /api/:collection endpoint.
   * Strapi-native filter syntax: ?filters[field][$eq]=value
   * locale defaults to 'en' when not provided.
   * Filters are optional — omitting them returns all entries (like Strapi's list endpoint).
   *
   * Examples:
   *   GET /api/pages?filters[slug][$eq]=/my-page/
   *   GET /api/pages?filters[slug][$eq]=/my-page/&locale=hi
   *   GET /api/articles?filters[category][$eq]=tech&locale=hi
   *   GET /api/component-instances  (list all)
   */
  app.get('/api/:collection', async (req, res) => {
    const { collection } = req.params;
    const locale = req.query.locale || 'en';

    // Raw query string without 'depth' (our custom param)
    const rawQsFull = req.url.includes('?') ? req.url.split('?').slice(1).join('?') : '';
    const rawQuery = rawQsFull.replace(/(?:^|&)depth=[^&]*/g, '').replace(/^&/, '');

    // If populate present, proxy directly to Strapi — skip depth pipeline
    const hasPopulate = 'populate' in req.query;
    if (hasPopulate) {
      try {
        const response = await strapiClient.proxyGet(`/api/${collection}`, rawQuery);
        return res.json(response);
      } catch (err) {
        const strapiStatus = err.response?.status;
        const strapiBody = err.response?.data;
        console.error(`[Server] Proxy error ${collection}:`, err.message, strapiBody ? JSON.stringify(strapiBody) : '');
        if (strapiStatus) return res.status(strapiStatus).json(strapiBody);
        return res.status(502).json({ error: 'Upstream unreachable', message: err.message });
      }
    }

    // depth omitted → 1 (populate=* only, fastest)
    // depth=N       → N levels of deepening passes, no CI resolution
    // depth=full    → full deep population + CI resolution
    // depth=<other> → 400 error
    const depth = req.query.depth || '1';
    let maxDepth;
    if (depth === 'full') {
      maxDepth = Infinity;
    } else {
      const parsed = parseInt(depth, 10);
      if (isNaN(parsed) || parsed < 1 || String(parsed) !== String(depth)) {
        return res.status(400).json({ error: 'depth must be a positive integer or "full"' });
      }
      maxDepth = parsed;
    }

    // Extract filters (from parsed req.query) for backward compatibility.
    // rawQuery is the authoritative source passed to Strapi; filters is used
    // only for the cache key and resolver's internal error messages.
    const filters = {};
    if (req.query.filters && typeof req.query.filters === 'object') {
      for (const [field, ops] of Object.entries(req.query.filters)) {
        if (ops != null && typeof ops === 'object' && '$eq' in ops) {
          filters[field] = ops['$eq'];
        } else if (typeof ops === 'string') {
          filters[field] = ops;
        }
      }
    }

    try {
      const cacheKey = `${collection}:${rawQuery}`;
      const cached = await cache.get(cacheKey, locale);
      if (cached) {
        res.set('X-Cache', 'HIT');
        if (Array.isArray(cached?.data)) {
          return res.json(cached);
        }
        return res.json({
          data: [cached],
          meta: {
            pagination: {
              page: 1,
              pageCount: 1,
              pageSize: 1,
              total: 1,
            },
          },
        });
      }

      res.set('X-Cache', 'MISS');
      const response = await resolver.resolveWithMeta(collection, filters, locale, { maxDepth, rawQuery });
      await cache.set(cacheKey, locale, response);
      return res.json(response);
    } catch (err) {
      const strapiStatus = err.response?.status;
      const strapiBody = err.response?.data;
      console.error(
        `[Server] Error resolving ${collection}:`,
        err.message,
        strapiBody ? JSON.stringify(strapiBody) : ''
      );

      if (strapiStatus) return res.status(strapiStatus).json(strapiBody);
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /webhook/strapi
   * Called by Strapi lifecycle hooks or webhooks on content publish.
   * Invalidates relevant cache entries.
   *
   * Body: { entry: { <cacheKeyField>?, locale? } }
   */
  app.post('/webhook/strapi', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (config.webhookSecret && secret !== config.webhookSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { entry } = req.body;

    try {
      const resourceKey =
        entry && typeof entry === 'object' ? entry[config.cacheKeyField || 'slug'] : null;

      if (resourceKey) {
        const locale = entry.locale || 'en';
        await cache.invalidate(resourceKey, locale);
        console.log(`[Webhook] Invalidated cache key: ${resourceKey}`);
      } else {
        await cache.invalidateAll();
        console.log('[Webhook] Entry key unavailable — invalidated all pages');
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[Webhook] Error:', err.message);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return { app, cache, strapiClient };
}

module.exports = createServer;
