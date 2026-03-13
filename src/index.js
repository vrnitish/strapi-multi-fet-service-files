require('dotenv').config();
const createServer = require('./server');

/**
 * Collection keys: maps field names to their Strapi collection plural API names.
 *
 * When the resolver encounters one of these field names in a response, it knows
 * the value is a relation to the specified collection and will fetch the full
 * entity by documentId.
 *
 * Format: COLLECTION_KEYS="field1:collection-name,field2:collection-name"
 * Example: COLLECTION_KEYS="component_instance:component-instances,component_instances:component-instances,user_types:user-types"
 */
function parseCollectionKeys(envValue) {
  const keys = {};
  if (!envValue) return keys;
  for (const pair of envValue.split(',')) {
    const [field, collection] = pair.trim().split(':');
    if (field && collection) {
      keys[field.trim()] = collection.trim();
    }
  }
  return keys;
}

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

  // Collection keys — maps field names → collection API names
  collectionKeys: parseCollectionKeys(process.env.COLLECTION_KEYS),

  // Locales — comma-separated locale codes to pre-seed instead of fetching
  // from /api/i18n/locales. Use this if the API token lacks i18n permission.
  // Example: LOCALES=en,hi,fr
  locales: process.env.LOCALES ? process.env.LOCALES.split(',').map((l) => l.trim()) : null,

  // Always-populate fields — field names that Strapi omits from populate=* when null.
  // Strapi REST API silently drops optional null component/relation fields;
  // listing them here forces an extra request so they appear as null in the response.
  // Example: ALWAYS_POPULATE_FIELDS=seo_elements,another_field
  alwaysPopulateFields: process.env.ALWAYS_POPULATE_FIELDS
    ? process.env.ALWAYS_POPULATE_FIELDS.split(',').map((f) => f.trim())
    : [],

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
  console.log(`[Server] Collection keys: ${JSON.stringify(config.collectionKeys)}`);
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
