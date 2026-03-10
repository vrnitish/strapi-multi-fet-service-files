/**
 * Strapi Page Resolver — Express HTTP Server
 *
 * Routes:
 *   GET  /page?slug=/your-page/&locale=en   → Resolved page JSON
 *   POST /webhook/strapi                     → Cache invalidation on publish
 *   GET  /health                             → Health check
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

  const resolver = new PageResolver(strapiClient, {
    maxDepth: config.maxDepth || 5,
  });

  const cache = new CacheManager({
    enabled: config.cacheEnabled !== false,
    redisUrl: config.redisUrl,
    ttl: config.cacheTtl || 300,
  });

  // ── Routes ─────────────────────────────────────────────────────────────────

  /**
   * GET /page?slug=/your-slug/&locale=en
   * Returns the fully resolved page matching the original Strapi response shape.
   */
  app.get('/page', async (req, res) => {
    const slug = req.query.slug;
    const locale = req.query.locale || 'en';

    if (!slug) {
      return res.status(400).json({ error: 'slug query param is required' });
    }

    try {
      // ── Cache check ──────────────────────────────────────────────────────
      const cached = await cache.get(slug, locale);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json({ data: [cached] }); // Preserve Strapi array envelope
      }

      // ── Resolve from Strapi ──────────────────────────────────────────────
      res.set('X-Cache', 'MISS');
      const pageData = await resolver.resolvePage(slug, locale);

      // ── Store in cache ───────────────────────────────────────────────────
      await cache.set(slug, locale, pageData);

      // Return in same envelope shape as original Strapi response
      return res.json({ data: [pageData] });
    } catch (err) {
      console.error(`[Server] Error resolving page ${slug}:`, err.message);

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
