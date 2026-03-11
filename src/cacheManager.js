/**
 * CacheManager
 *
 * Wraps Redis for page-level caching with automatic invalidation support.
 * Falls back gracefully if Redis is unavailable (cache miss → live fetch).
 */

const redis = require('redis');

class CacheManager {
  constructor(config = {}) {
    this.ttl = config.ttl || 300; // 5 minutes default
    this.keyPrefix = config.keyPrefix || 'strapi:page:';
    this.enabled = config.enabled !== false;
    this.client = null;

    if (this.enabled && config.redisUrl) {
      this._connect(config.redisUrl);
    } else if (this.enabled) {
      console.warn('[Cache] Redis URL not provided — caching disabled');
      this.enabled = false;
    }
  }

  async _connect(redisUrl) {
    try {
      this.client = redis.createClient({ url: redisUrl });
      this.client.on('error', (err) =>
        console.error('[Cache] Redis error:', err.message)
      );
      this.client.on('connect', () => console.log('[Cache] Redis connected'));
      await this.client.connect();
    } catch (err) {
      console.error('[Cache] Redis connection failed:', err.message);
      this.enabled = false;
    }
  }

  _key(slug, locale) {
    return `${this.keyPrefix}${locale}:${slug}`;
  }

  async get(slug, locale = 'en') {
    if (!this.enabled || !this.client) return null;

    try {
      const raw = await this.client.get(this._key(slug, locale));
      if (!raw) return null;
      console.log(`[Cache] HIT for ${slug} (${locale})`);
      return JSON.parse(raw);
    } catch (err) {
      console.warn('[Cache] Get error:', err.message);
      return null;
    }
  }

  async set(slug, locale = 'en', data) {
    if (!this.enabled || !this.client) return;

    try {
      await this.client.setEx(
        this._key(slug, locale),
        this.ttl,
        JSON.stringify(data)
      );
      console.log(`[Cache] SET for ${slug} (${locale}) TTL=${this.ttl}s`);
    } catch (err) {
      console.warn('[Cache] Set error:', err.message);
    }
  }

  async invalidate(slug, locale = 'en') {
    if (!this.enabled || !this.client) return;

    try {
      await this.client.del(this._key(slug, locale));
      console.log(`[Cache] INVALIDATED ${slug} (${locale})`);
    } catch (err) {
      console.warn('[Cache] Invalidate error:', err.message);
    }
  }

  /**
   * Invalidate all cached pages for all locales.
   * Used when a shared component is updated.
   */
  async invalidateAll() {
    if (!this.enabled || !this.client) return;

    try {
      const keys = await this.client.keys(`${this.keyPrefix}*`);
      if (keys.length > 0) {
        await this.client.del(keys);
        console.log(`[Cache] INVALIDATED ${keys.length} pages`);
      }
    } catch (err) {
      console.warn('[Cache] Invalidate all error:', err.message);
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
    }
  }
}

module.exports = CacheManager;
