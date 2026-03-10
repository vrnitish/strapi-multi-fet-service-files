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
 *   Fix: after the layout tree is fully visible, find every "container array"
 *   (array of real objects) and explicitly add [field][fields][0]=documentId
 *   populate for any known relation field names (e.g. component_instance).
 */

'use strict';

const SYSTEM_KEYS = new Set([
  'id',
  'documentId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'locale',
  '__component',
  'localizations',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Stub detection (Problem A)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `obj` is an unpopulated Strapi entity stub.
 * A stub has identity fields (id/documentId) but no content fields.
 */
function isStub(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!obj.documentId && !obj.id) return false;
  const contentKeys = Object.keys(obj).filter((k) => !SYSTEM_KEYS.has(k));
  return contentKeys.length === 0;
}

/**
 * Walk a Strapi response tree and collect field-segment paths for every stub.
 *
 * @param {*}      data
 * @param {object} opts
 * @param {string[]}     [opts.segments]     - current path (internal)
 * @param {WeakSet}      [opts.visited]      - cycle guard (internal)
 * @param {Set<string>}  [opts.stopAtFields] - skip these field names entirely
 */
function collectStubPaths(
  data,
  { segments = [], visited = new WeakSet(), stopAtFields = new Set() } = {}
) {
  if (!data || typeof data !== 'object') return [];
  if (visited.has(data)) return [];
  visited.add(data);

  const paths = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      paths.push(...collectStubPaths(item, { segments, visited, stopAtFields }));
    }
    return paths;
  }

  for (const [key, value] of Object.entries(data)) {
    if (SYSTEM_KEYS.has(key) || value === null || value === undefined) continue;
    if (stopAtFields.has(key)) continue;

    const nextSegments = [...segments, key];

    if (Array.isArray(value)) {
      const items = value.filter(Boolean);
      if (items.length > 0 && items.every(isStub)) {
        paths.push(nextSegments);
      } else {
        paths.push(
          ...collectStubPaths(value, { segments: nextSegments, visited, stopAtFields })
        );
      }
    } else if (typeof value === 'object') {
      if (isStub(value)) {
        paths.push(nextSegments);
      } else {
        paths.push(
          ...collectStubPaths(value, { segments: nextSegments, visited, stopAtFields })
        );
      }
    }
  }

  return paths;
}

// ─────────────────────────────────────────────────────────────────────────────
// Absent relation detection (Problem B)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the data tree and collect paths to every "leaf container" array.
 *
 * A leaf container is an array of real (non-stub) objects whose items do NOT
 * themselves contain further nested arrays of real objects. This targets the
 * level where component_instance lives (e.g. columns) rather than the parent
 * dynamic-zone level (e.g. layout whose items have a columns sub-array).
 *
 * Why leaf-only: layout items → have columns array → not a leaf → skip.
 *               columns items → no sub-arrays → leaf → add CI populate. ✓
 * This avoids "Invalid key component_instance at layout" 400 errors while
 * still correctly finding the actual containers that need CI populate.
 *
 * @param {*}      data
 * @param {object} opts
 * @param {string[]}    [opts.segments]     - current path (internal)
 * @param {WeakSet}     [opts.visited]      - cycle guard (internal)
 * @param {Set<string>} [opts.stopAtFields] - don't recurse into these fields
 */
function collectContainerPaths(
  data,
  { segments = [], visited = new WeakSet(), stopAtFields = new Set() } = {}
) {
  if (!data || typeof data !== 'object') return [];
  if (visited.has(data)) return [];
  visited.add(data);

  const paths = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      paths.push(...collectContainerPaths(item, { segments, visited, stopAtFields }));
    }
    return paths;
  }

  for (const [key, value] of Object.entries(data)) {
    if (SYSTEM_KEYS.has(key)) continue;
    if (stopAtFields.has(key)) continue;
    if (!value) continue;

    const nextSegments = [...segments, key];

    if (Array.isArray(value)) {
      const realObjs = value.filter(
        (v) => v && typeof v === 'object' && !Array.isArray(v) && !isStub(v)
      );
      if (realObjs.length > 0) {
        // At depth 1 (direct page/component fields), only add as CI container
        // if items are leaf arrays — i.e. no further nested arrays of real
        // objects. This prevents "Invalid key component_instance at layout"
        // 400 errors when the depth-1 field is a Strapi dynamic zone.
        //
        // At depth 2+, always add as CI container even if items have
        // sub-arrays — nested component arrays can have component_instance
        // at any level regardless of further nesting below them.
        const hasNestedArrays = realObjs.some((v) =>
          Object.values(v).some(
            (fv) =>
              Array.isArray(fv) &&
              fv.some((fvi) => fvi && typeof fvi === 'object' && !Array.isArray(fvi) && !isStub(fvi))
          )
        );
        if (!hasNestedArrays || nextSegments.length > 1) {
          paths.push(nextSegments);
        }
      }
      // Always recurse to find deeper containers.
      paths.push(
        ...collectContainerPaths(value, { segments: nextSegments, visited, stopAtFields })
      );
    } else if (typeof value === 'object' && !isStub(value)) {
      paths.push(
        ...collectContainerPaths(value, { segments: nextSegments, visited, stopAtFields })
      );
    }
  }

  return paths;
}

/**
 * For each container path, build URLSearchParams entries that will fetch
 * a known relation field (e.g. component_instance) with only its documentId.
 *
 * Generates: populate[…container…][populate][ciField][fields][0]=documentId
 *
 * @param {string[][]} containerPaths  - output of collectContainerPaths()
 * @param {string}     ciField         - relation field name to fetch (default: 'component_instance')
 * @returns {Array<[string, string]>}  - [key, value] pairs ready for URLSearchParams.set()
 */
function buildCIPopulateEntries(containerPaths, ciField = 'component_instance') {
  const entries = [];
  const seen = new Set();

  for (const segments of containerPaths) {
    // populate[a][populate][b][populate] + [component_instance][fields][0]
    const base = segmentsToPopulateKey(segments);
    const key = `${base}[${ciField}][fields][0]`;

    if (!seen.has(key)) {
      seen.add(key);
      entries.push([key, 'documentId']);
    }
  }

  return entries;
}

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
 * @param {string[][]} stubPaths          - accumulated stub paths from all passes
 * @param {object}     opts
 * @param {string}     [opts.locale]
 * @param {string}     [opts.slug]            - adds filters[slug][$eq] (page fetches)
 * @param {string}     [opts.basePopulateKey] - e.g. 'populate[layout][populate]'
 * @param {string}     [opts.basePopulateValue] - default '*'
 * @param {Array<[string,string]>} [opts.extraEntries] - additional key/value params
 */
function buildDeepPopulateParams(stubPaths, opts = {}) {
  const {
    locale,
    slug,
    basePopulateKey,
    basePopulateValue = '*',
    extraEntries = [],
  } = opts;

  const params = new URLSearchParams();

  if (slug)   params.set('filters[slug][$eq]', slug);
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
 * Returns true if `value` looks like a shallow-populated relation:
 *   - An object or array of objects that have an `id`
 *   - Each object has 1–3 non-system content fields (under-populated)
 *   - None have `__component` (embedded components are never shallow)
 *
 * Used to detect fields like `layout: [{ id, row_title }]` that need deeper
 * populate via the Strapi Fragment API.
 */
function isShallowRelation(value) {
  const items = Array.isArray(value)
    ? value.filter((v) => v && typeof v === 'object' && !Array.isArray(v))
    : value && typeof value === 'object' && !Array.isArray(value)
    ? [value]
    : [];
  if (items.length === 0) return false;
  return items.every((item) => {
    if ('__component' in item) return false; // embedded component, not a relation
    if (!item.id) return false;
    const contentKeys = Object.keys(item).filter((k) => !SYSTEM_KEYS.has(k));
    return contentKeys.length >= 1 && contentKeys.length <= 3;
  });
}

/**
 * Walk a `components[]` array (from a component-instance response).
 * For each `__component` UID, detect fields containing shallow-relation data
 * and generate Fragment populate entries to fetch them fully.
 *
 * Output example:
 *   ['populate[components][on][components.composition-wrapper][populate][layout][populate]', '*']
 */
function buildFragmentDeepEntries(components) {
  const entries = [];
  const seen = new Set();

  for (const comp of components || []) {
    if (!comp || !comp.__component) continue;
    const uid = comp.__component;

    for (const [field, value] of Object.entries(comp)) {
      if (SYSTEM_KEYS.has(field) || field === '__component' || value == null) continue;
      if (isShallowRelation(value)) {
        const key = `populate[components][on][${uid}][populate][${field}][populate]`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push([key, '*']);
        }
      }
    }
  }

  return entries;
}

/**
 * Walk a `components[]` array (after deeper populate), find all container
 * arrays within each component type's data, and generate Fragment CI populate
 * entries to surface component_instance stubs at every level.
 *
 * Output example:
 *   ['populate[components][on][components.composition-wrapper][populate][layout][populate][columns][populate][component_instance][fields][0]', 'documentId']
 *
 * @param {Array}       components    - data.components from a component-instance response
 * @param {Set<string>} stopAtFields  - field names to stop scanning at (e.g. CI_STOP_FIELDS)
 * @param {string}      ciField       - relation field name (default: 'component_instance')
 */
function buildFragmentCIEntries(
  components,
  stopAtFields = new Set(),
  ciField = 'component_instance'
) {
  const entries = [];
  const seen = new Set();

  for (const comp of components || []) {
    if (!comp || !comp.__component) continue;
    const uid = comp.__component;

    const containerPaths = collectContainerPaths(comp, { stopAtFields });
    for (const segments of containerPaths) {
      const innerPath = segments.join('][populate][');
      const key = `populate[components][on][${uid}][populate][${innerPath}][populate][${ciField}][fields][0]`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push([key, 'documentId']);
      }
    }
  }

  return entries;
}

module.exports = {
  isStub,
  collectStubPaths,
  collectContainerPaths,
  buildCIPopulateEntries,
  buildDeepPopulateParams,
  buildFragmentDeepEntries,
  buildFragmentCIEntries,
};
