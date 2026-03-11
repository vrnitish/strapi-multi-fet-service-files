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
        return res.json({ data: [cached] });
      }

      res.set('X-Cache', 'MISS');
      const data = await resolver.resolve(collection, filters, locale);
      await cache.set(cacheKey, locale, data);
      return res.json({ data: [data] });
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
   * Body: { model: 'page' | 'component-instance', entry: { slug?, locale? } }
   */
  app.post('/webhook/strapi', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (config.webhookSecret && secret !== config.webhookSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { model, entry } = req.body;

    try {
      if (model === 'page' && entry?.slug) {
        // Specific page updated — invalidate just that page
        const locale = entry.locale || 'en';
        await cache.invalidate(entry.slug, locale);
        console.log(`[Webhook] Invalidated page: ${entry.slug}`);
      } else if (
        model === 'component-instance' ||
        model === 'component-wrapper'
      ) {
        // Shared component updated — invalidate ALL pages since we don't
        // know which pages reference this component
        await cache.invalidateAll();
        console.log(`[Webhook] Shared component updated — invalidated all pages`);
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
