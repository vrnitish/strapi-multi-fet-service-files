/**
 * deepPopulate — generic Strapi response scanner
 *
 * Handles two distinct problems:
 *
 * Problem A — stubs (objects that ARE in the response but under-populated):
 *   populate[x][populate]=* returns { id, documentId } with no content fields.
 *   Fix: iterative scan → re-fetch with deeper populate params.
 *
 * Problem B — absent relations (fields that are MISSING from the response):
 *   Strapi completely omits unpopulated relation fields — there is nothing
 *   to detect via stub scanning.
 *   Fix: deepen generic object/array paths one level at a time. Once a
 *   relation becomes visible, stop traversing it by value-shape rather than
 *   by hardcoded field name, and let PageResolver handle it separately.
 */

'use strict';

function normalizeSchema(schema = {}) {
  return {
    entityLabelField: schema.entityLabelField || 'component_title',
    localizationField: schema.localizationField || 'localizations',
    componentTypeField: schema.componentTypeField || '__component',
    componentZoneField: schema.componentZoneField || 'components',
  };
}

function getSystemKeys(schema = {}) {
  const normalized = normalizeSchema(schema);
  return new Set([
    'id',
    'documentId',
    'createdAt',
    'updatedAt',
    'publishedAt',
    'locale',
    normalized.componentTypeField,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stub detection (Problem A)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `obj` is an unpopulated Strapi entity stub.
 * A stub has identity fields (id/documentId) but no content fields.
 */
function isStub(obj, schema = {}) {
  const systemKeys = getSystemKeys(schema);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!obj.documentId && !obj.id) return false;
  const contentKeys = Object.keys(obj).filter((k) => !systemKeys.has(k));
  return contentKeys.length === 0;
}

function isCIEntity(obj, schema = {}) {
  const normalized = normalizeSchema(schema);
  return (
    obj != null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    typeof obj.documentId === 'string' &&
    normalized.entityLabelField in obj
  );
}

function shouldStopAtValue(value, schema = {}) {
  if (!value || typeof value !== 'object') return false;
  if (isCIEntity(value, schema)) return true;
  if (!Array.isArray(value)) return false;

  const objects = value.filter((item) => item && typeof item === 'object');
  return objects.length > 0 && objects.every((item) => isCIEntity(item, schema));
}

/**
 * Returns true if `value` is a polymorphic dynamic zone — an array whose
 * items carry `componentTypeField` (default `__component`).
 *
 * Strapi rejects specific-field populate params that go INSIDE a dynamic
 * zone (e.g. `populate[components][populate][nav_links]`). Only `=*` or
 * the Fragment API (`[on][uid][populate]...`) can be used. Scanners must
 * stop at dynamic zones so the Fragment API handles them instead.
 */
function isDynamicZone(value, schema = {}) {
  if (!Array.isArray(value)) return false;
  const normalized = normalizeSchema(schema);
  return value.some(
    (item) => item && typeof item === 'object' && normalized.componentTypeField in item
  );
}

/**
 * Walk a Strapi response tree and collect field-segment paths for every stub.
 *
 * @param {*}      data
 * @param {object} opts
 * @param {string[]}     [opts.segments]        - current path (internal)
 * @param {WeakSet}      [opts.visited]         - cycle guard (internal)
 * @param {boolean}      [opts.stopAtEntities]  - when true, stop at CI entities
 *        (default true — used by Fragment API context; pass false for page-level
 *        scanning so populate params traverse through all relations regardless
 *        of which collection they belong to)
 */
function collectStubPaths(data, { segments = [], visited = new WeakSet(), schema = {}, stopAtEntities = true } = {}) {
  const systemKeys = getSystemKeys(schema);
  if (!data || typeof data !== 'object') return [];
  if (visited.has(data)) return [];
  visited.add(data);

  const paths = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      paths.push(...collectStubPaths(item, { segments, visited, schema, stopAtEntities }));
    }
    return paths;
  }

  const normalized = normalizeSchema(schema);

  for (const [key, value] of Object.entries(data)) {
    if (systemKeys.has(key) || value === null || value === undefined) continue;
    // Always stop at dynamic zones — Strapi requires Fragment API for those
    if (isDynamicZone(value, schema)) continue;
    if (stopAtEntities && shouldStopAtValue(value, schema)) continue;

    const nextSegments = [...segments, key];

    // Localizations: add path for deepening but never recurse into it —
    // prevents infinite localizations.localizations.localizations... chains.
    if (key === normalized.localizationField) {
      if (Array.isArray(value) && value.length > 0 && value.every((item) => isStub(item, schema))) {
        paths.push(nextSegments);
      }
      continue;
    }

    if (Array.isArray(value)) {
      const items = value.filter(Boolean);
      if (items.length > 0 && items.every((item) => isStub(item, schema))) {
        paths.push(nextSegments);
      } else {
        paths.push(...collectStubPaths(value, { segments: nextSegments, visited, schema, stopAtEntities }));
      }
    } else if (typeof value === 'object') {
      if (isStub(value, schema)) {
        paths.push(nextSegments);
      } else {
        paths.push(...collectStubPaths(value, { segments: nextSegments, visited, schema, stopAtEntities }));
      }
    }
  }

  return paths;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep-path detection (Problem A+) — proactive deepening for absent relations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the tree and collect paths to every field containing an array of
 * real (non-stub) objects. These represent fields whose items may have
 * absent sub-relations that `populate=*` didn't reveal.
 *
 * Unlike collectStubPaths (which finds under-populated stubs), this finds
 * fully-populated objects that could still have missing nested relations.
 * Used in the iterative deepening loop to proactively reveal tree structure
 * one level at a time.
 *
 * @param {boolean} [opts.stopAtEntities] - when true, stop at CI entities
 *        (default true — Fragment API context; pass false for page-level
 *        scanning so populate params traverse through all relations)
 */
function collectDeepPaths(data, { segments = [], visited = new WeakSet(), schema = {}, stopAtEntities = true } = {}) {
  const systemKeys = getSystemKeys(schema);
  if (!data || typeof data !== 'object') return [];
  if (visited.has(data)) return [];
  visited.add(data);

  const paths = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      paths.push(...collectDeepPaths(item, { segments, visited, schema, stopAtEntities }));
    }
    return paths;
  }

  const normalized = normalizeSchema(schema);

  for (const [key, value] of Object.entries(data)) {
    if (systemKeys.has(key) || value == null) continue;
    // Always stop at dynamic zones — Strapi requires Fragment API for those
    if (isDynamicZone(value, schema)) continue;
    if (stopAtEntities && shouldStopAtValue(value, schema)) continue;

    const nextSegments = [...segments, key];

    // Localizations: add path for deepening but never recurse into it —
    // prevents infinite localizations.localizations.localizations... chains.
    if (key === normalized.localizationField) {
      if (Array.isArray(value)) {
        const realObjs = value.filter(
          (v) => v && typeof v === 'object' && !Array.isArray(v) && !isStub(v, schema)
        );
        if (realObjs.length > 0) {
          paths.push(nextSegments);
        }
      }
      continue;
    }

    if (Array.isArray(value)) {
      const realObjs = value.filter(
        (v) => v && typeof v === 'object' && !Array.isArray(v) && !isStub(v, schema)
      );
      if (realObjs.length > 0) {
        paths.push(nextSegments);
        // Recurse into items to find deeper real-object arrays
        for (const item of realObjs) {
          paths.push(...collectDeepPaths(item, { segments: nextSegments, visited, schema, stopAtEntities }));
        }
      }
    } else if (typeof value === 'object' && !isStub(value, schema)) {
      // Single real object — deepen it and recurse to find deeper arrays within it
      paths.push(nextSegments);
      paths.push(...collectDeepPaths(value, { segments: nextSegments, visited, schema, stopAtEntities }));
    }
  }

  return paths;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Populate param builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a segment-path array to a Strapi URLSearchParams key.
 *
 * ['layout', 'columns', 'rows']
 *   → 'populate[layout][populate][columns][populate][rows][populate]'
 */
function segmentsToPopulateKey(segments) {
  return 'populate[' + segments.join('][populate][') + '][populate]';
}

/**
 * Build URLSearchParams for a deep-populate re-fetch.
 *
 * @param {string[][]} stubPaths          - accumulated paths from all passes
 * @param {object}     opts
 * @param {string}     [opts.locale]
 * @param {object}     [opts.filters]         - Strapi filter fields (e.g. { slug: '/page/' })
 * @param {string}     [opts.basePopulateKey] - e.g. 'populate[layout][populate]'
 * @param {string}     [opts.basePopulateValue] - default '*'
 * @param {Array<[string,string]>} [opts.extraEntries] - additional key/value params
 */
function buildDeepPopulateParams(stubPaths, opts = {}) {
  const {
    locale,
    filters = {},
    basePopulateKey,
    basePopulateValue = '*',
    extraEntries = [],
  } = opts;

  const params = new URLSearchParams();

  for (const [field, value] of Object.entries(filters)) {
    params.set(`filters[${field}][$eq]`, value);
  }
  if (locale) params.set('locale', locale);
  if (basePopulateKey) params.set(basePopulateKey, basePopulateValue);

  for (const segments of leafPaths(stubPaths)) {
    const key = segmentsToPopulateKey(segments);
    // Skip if any extraEntry is a more-specific child of this path —
    // sending both would cause a qs type conflict on the server.
    if (extraEntries.some(([ek]) => ek.startsWith(key + '['))) continue;
    params.set(key, '*');
  }

  for (const [key, val] of extraEntries) {
    params.set(key, val);
  }

  return params;
}

/**
 * Remove exact duplicate paths only.
 */
function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((segments) => {
    const key = segments.join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Filter to only leaf paths — remove any path that is a strict prefix of
 * another path in the set. Prevents qs conflicts when both a parent populate
 * param (e.g. populate[X][populate]=*) and a child param
 * (e.g. populate[X][populate][Y][populate]=*) are sent in the same request.
 * Strapi's qs parser cannot represent the same key as both a string and an
 * object, so the shallower '*' gets corrupted and fields go missing.
 */
function leafPaths(paths) {
  const unique = uniquePaths(paths);
  return unique.filter((p) => {
    const prefix = p.join('\0') + '\0';
    return !unique.some((other) => other.join('\0').startsWith(prefix));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fragment API helpers (Problem C — polymorphic dynamic zones)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk a `components[]` array and find ALL paths that need deeper population:
 * both arrays/objects of real data (collectDeepPaths) AND under-populated
 * stubs (collectStubPaths). Stop once a value looks like a component entity;
 * PageResolver resolves those separately.
 *
 * Output example:
 *   ['populate[components][on][components.composition-wrapper][populate][layout][populate]', '*']
 */
function buildFragmentDeepPathEntries(items, schema = {}) {
  const normalized = normalizeSchema(schema);
  const entries = [];
  const seen = new Set();

  for (const comp of items || []) {
    if (!comp || !comp[normalized.componentTypeField]) continue;
    const uid = comp[normalized.componentTypeField];

    const deepPaths = collectDeepPaths(comp, { schema: normalized });
    const stubPaths = collectStubPaths(comp, { schema: normalized });
    const allPaths = uniquePaths([...deepPaths, ...stubPaths]);
    const leaves = leafPaths(allPaths);

    for (const segments of leaves) {
      const innerPath = segments.join('][populate][');
      const key = `populate[components][on][${uid}][populate][${innerPath}][populate]`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push([key, '*']);
      }
    }
  }

  return entries;
}

module.exports = {
  collectStubPaths,
  collectDeepPaths,
  uniquePaths,
  buildDeepPopulateParams,
  buildFragmentDeepPathEntries,
  isCIEntity,
  isDynamicZone,
  shouldStopAtValue,
  normalizeSchema,
};
