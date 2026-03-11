require('dotenv').config();
const createServer = require('./server');

const config = {
  // Strapi
  strapiUrl: process.env.STRAPI_URL || 'http://localhost:1337',
  strapiToken: process.env.STRAPI_TOKEN || '',
  strapiTimeout: parseInt(process.env.STRAPI_TIMEOUT || '10000'),
  componentCollection: process.env.COMPONENT_COLLECTION || 'component-instances',
  componentZoneField: process.env.COMPONENT_ZONE_FIELD || 'components',
  componentTypeField: process.env.COMPONENT_TYPE_FIELD || '__component',
  entityLabelField: process.env.ENTITY_LABEL_FIELD || 'component_title',
  localizationField: process.env.LOCALIZATION_FIELD || 'localizations',

  // Cache
  cacheEnabled: process.env.CACHE_ENABLED !== 'false',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  cacheTtl: parseInt(process.env.CACHE_TTL || '300'),
  cacheKeyField: process.env.CACHE_KEY_FIELD || 'slug',

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
