require('dotenv').config();
const createServer = require('./server');

const config = {
  // Strapi
  strapiUrl: process.env.STRAPI_URL || 'http://localhost:1337',
  strapiToken: process.env.STRAPI_TOKEN || '',
  strapiTimeout: parseInt(process.env.STRAPI_TIMEOUT || '10000'),

  // Cache
  cacheEnabled: process.env.CACHE_ENABLED !== 'false',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  cacheTtl: parseInt(process.env.CACHE_TTL || '300'),

  // Security
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // Server
  port: parseInt(process.env.PORT || '3001'),
};

const { app, cache } = createServer(config);

const server = app.listen(config.port, () => {
  console.log(`[Server] Strapi Page Resolver running on port ${config.port}`);
  console.log(`[Server] Strapi URL: ${config.strapiUrl}`);
  console.log(`[Server] Cache: ${config.cacheEnabled ? 'enabled' : 'disabled'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] Shutting down...');
  server.close(async () => {
    await cache.disconnect();
    process.exit(0);
  });
});
