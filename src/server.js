/**
 * Strapi Page Resolver — Express HTTP Server
 *
 * Routes:
 *   GET  /resolve/:collection?<filters>&locale=en  → Resolved entry JSON
 *   POST /webhook/strapi                            → Cache invalidation on publish
 *   GET  /health                                    → Health check
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
    componentCollection: config.componentCollection,
    componentZoneField: config.componentZoneField,
    componentTypeField: config.componentTypeField,
    entityLabelField: config.entityLabelField,
    localizationField: config.localizationField,
  });

  const resolver = new PageResolver(strapiClient);

  const cache = new CacheManager({
    enabled: config.cacheEnabled !== false,
    redisUrl: config.redisUrl,
    ttl: config.cacheTtl || 300,
  });

  // ── Routes ─────────────────────────────────────────────────────────────────

  /**
   * GET /resolve/:collection?<filters>&locale=en
   * Generic route — resolves any Strapi collection entry with full CI tree.
   * All query params except `locale` are treated as Strapi filters.
   *
   * Examples:
   *   GET /resolve/pages?slug=/my-page/&locale=en
   *   GET /resolve/articles?category=tech&locale=hi
   *   GET /resolve/landing-pages?slug=/promo/&site_code=adv
   */
  app.get('/resolve/:collection', async (req, res) => {
    const { collection } = req.params;
    const { locale = 'en', ...filters } = req.query;

    if (Object.keys(filters).length === 0) {
      return res.status(400).json({ error: 'At least one filter query param is required' });
    }

    try {
      const cacheKey = `${collection}:${JSON.stringify(filters)}`;
      const cached = await cache.get(cacheKey, locale);
      if (cached) {
        res.set('X-Cache', 'HIT');
        if (cached && Array.isArray(cached.data)) {
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
      const response = await resolver.resolveWithMeta(collection, filters, locale);
      await cache.set(cacheKey, locale, response);
      return res.json(response);
    } catch (err) {
      const strapiBody = err.response?.data;
      console.error(
        `[Server] Error resolving ${collection}:`,
        err.message,
        strapiBody ? JSON.stringify(strapiBody) : ''
      );

      if (err.message.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }

      return res.status(500).json({ error: 'Internal server error' });
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

  /**
   * GET /health
   */
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return { app, cache };
}

module.exports = createServer;
