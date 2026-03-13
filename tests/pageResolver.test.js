/**
 * Tests validate the resolver against the real data shape from data/valid.json.
 * Mock data is derived programmatically from valid.json to ensure completeness.
 */

const PageResolver = require('../src/pageResolver');
const fs = require('fs');
const path = require('path');

// ── Load reference data ─────────────────────────────────────────────────────

const validJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'valid.json'), 'utf8')
);
const EXPECTED_PAGE = validJson.data[0];

// ── Collection keys config for tests ────────────────────────────────────────

const COLLECTION_KEYS = {
  component_instance: 'component-instances',
  component_instances: 'component-instances',
  user_types: 'user-types',
};

const SKIP_KEYS = new Set(['localizations']);

// ── Helpers to derive mock data from valid.json ─────────────────────────────

function isCollectionRelation(key) {
  return key in COLLECTION_KEYS;
}

function hasDocumentId(obj) {
  return (
    obj != null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    typeof obj.documentId === 'string'
  );
}

function toStub(entity) {
  // pLevel=4 returns full data at the entity level including component_title etc.
  // But nested collection relations within it are stubs.
  // For the page shell, collection-relation values are stubs with basic fields.
  const stub = { id: entity.id, documentId: entity.documentId };
  if (entity.component_title) stub.component_title = entity.component_title;
  if (entity.locale) stub.locale = entity.locale;
  return stub;
}

/**
 * Walk the fully-resolved page, replace every collection-relation value with
 * a stub, and collect each entity's data (with its own nested relations also stubbed).
 */
function buildMocksFromValid(fullPage) {
  const entityMap = {}; // "collection:documentId" → data with stubs
  const pageShell = _replaceRelations(fullPage, entityMap);
  return { pageShell, entityMap };
}

function _replaceRelations(node, entityMap) {
  if (!node || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => _replaceRelations(item, entityMap));
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) {
      result[key] = value;
      continue;
    }

    const collection = COLLECTION_KEYS[key];

    if (collection && hasDocumentId(value)) {
      // Single collection relation
      _collectEntity(collection, value, entityMap);
      result[key] = toStub(value);
    } else if (collection && Array.isArray(value)) {
      // Plural collection relation
      result[key] = value.map((item) => {
        if (hasDocumentId(item)) {
          _collectEntity(collection, item, entityMap);
          return toStub(item);
        }
        return _replaceRelations(item, entityMap);
      });
    } else {
      result[key] = _replaceRelations(value, entityMap);
    }
  }
  return result;
}

function _collectEntity(collection, entity, entityMap) {
  const cacheKey = `${collection}:${entity.documentId}`;
  if (cacheKey in entityMap) return;
  entityMap[cacheKey] = null; // reserve slot to prevent re-entry
  const data = {};
  for (const [key, value] of Object.entries(entity)) {
    if (SKIP_KEYS.has(key)) {
      data[key] = value;
      continue;
    }
    data[key] = _replaceRelations(value, entityMap);
  }
  entityMap[cacheKey] = data;
}

/**
 * Build the expected resolved output by replacing stubs with entityMap data,
 * recursively. This accounts for the resolver's deduplication: the same entity
 * always gets the same cached data everywhere in the tree.
 */
function buildExpected(shell, entityMap) {
  const cache = {};
  return _resolveNode(JSON.parse(JSON.stringify(shell)), entityMap, cache);
}

function _resolveNode(node, entityMap, cache) {
  if (!node || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => _resolveNode(item, entityMap, cache));
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) {
      result[key] = value;
      continue;
    }

    const collection = COLLECTION_KEYS[key];

    if (collection && hasDocumentId(value)) {
      result[key] = _resolvedEntity(collection, value.documentId, entityMap, cache);
    } else if (collection && Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (hasDocumentId(item)) {
          return _resolvedEntity(collection, item.documentId, entityMap, cache);
        }
        return _resolveNode(item, entityMap, cache);
      });
    } else {
      result[key] = _resolveNode(value, entityMap, cache);
    }
  }
  return result;
}

function _resolvedEntity(collection, docId, entityMap, cache) {
  const cacheKey = `${collection}:${docId}`;
  if (cacheKey in cache) return cache[cacheKey];
  cache[cacheKey] = null;
  cache[cacheKey] = _resolveNode(
    JSON.parse(JSON.stringify(entityMap[cacheKey])),
    entityMap,
    cache
  );
  return cache[cacheKey];
}

// ── Build mock data + expected output ────────────────────────────────────────

const { pageShell: PAGE_SHELL, entityMap: ENTITY_MAP } = buildMocksFromValid(EXPECTED_PAGE);

const RESOLVED_EXPECTED = buildExpected(PAGE_SHELL, ENTITY_MAP);

function createMockClient() {
  return {
    collectionKeys: COLLECTION_KEYS,
    schema: {
      entityLabelField: 'component_title',
      localizationField: 'localizations',
    },
    findCollectionRelations: jest.fn().mockImplementation(function (data, visited) {
      // Use real implementation from StrapiClient
      const StrapiClient = require('../src/strapiClient');
      const client = new StrapiClient({
        baseUrl: 'http://localhost:1337',
        token: '',
        collectionKeys: COLLECTION_KEYS,
      });
      return client.findCollectionRelations(data, visited);
    }),
    fetchEntry: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(PAGE_SHELL))),
    fetchEntryWithMeta: jest.fn().mockResolvedValue({
      entry: JSON.parse(JSON.stringify(PAGE_SHELL)),
      meta: {
        pagination: {
          page: 1,
          pageCount: 1,
          pageSize: 25,
          total: 1,
        },
      },
    }),
    fetchBatchByDocumentId: jest.fn().mockImplementation((collection, docIds) => {
      const result = {};
      for (const id of docIds) {
        const cacheKey = `${collection}:${id}`;
        result[id] = ENTITY_MAP[cacheKey]
          ? JSON.parse(JSON.stringify(ENTITY_MAP[cacheKey]))
          : null;
      }
      return Promise.resolve(result);
    }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PageResolver', () => {
  let mockClient;
  let resolver;

  beforeEach(() => {
    mockClient = createMockClient();
    resolver = new PageResolver(mockClient);
  });

  // ── Full resolution validation ──────────────────────────────────────────

  test('resolved output matches valid.json reference data', async () => {
    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    expect(result).toEqual(RESOLVED_EXPECTED);
  });

  // ── Entry fetching ──────────────────────────────────────────────────────

  test('fetches entry via generic fetchEntry', async () => {
    await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    expect(mockClient.fetchEntry).toHaveBeenCalledWith('pages', {
      filters: { slug: '/dynamic/{{dynamic}}/' },
      locale: 'en',
    });
  });

  test('resolve() works with any collection and filters', async () => {
    await resolver.resolve('articles', { category: 'tech' }, 'en');
    expect(mockClient.fetchEntry).toHaveBeenCalledWith('articles', {
      filters: { category: 'tech' },
      locale: 'en',
    });
  });

  test('resolve() uses default filters and locale when omitted', async () => {
    await resolver.resolve('pages');
    expect(mockClient.fetchEntry).toHaveBeenCalledWith('pages', {
      filters: {},
      locale: 'en',
    });
  });

  test('resolveWithMeta() returns Strapi-like response envelope', async () => {
    const result = await resolver.resolveWithMeta(
      'pages',
      { slug: '/dynamic/{{dynamic}}/' },
      'en'
    );

    expect(mockClient.fetchEntryWithMeta).toHaveBeenCalledWith('pages', {
      filters: { slug: '/dynamic/{{dynamic}}/' },
      locale: 'en',
    });
    expect(result).toEqual({
      data: [RESOLVED_EXPECTED],
      meta: {
        pagination: {
          page: 1,
          pageCount: 1,
          pageSize: 25,
          total: 1,
        },
      },
    });
  });

  // ── Collection relation detection ─────────────────────────────────────

  test('finds collection relations in page shell', async () => {
    await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    expect(mockClient.findCollectionRelations).toHaveBeenCalled();
  });

  test('resolves all 7 unique component instances', async () => {
    await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    const allFetchedIds = new Set();
    for (const call of mockClient.fetchBatchByDocumentId.mock.calls) {
      if (call[0] === 'component-instances') {
        for (const id of call[1]) allFetchedIds.add(id);
      }
    }
    expect(allFetchedIds.size).toBe(7);
  });

  // ── Deep nesting ────────────────────────────────────────────────────────

  test('deeply nested composition wrappers are fully resolved', async () => {
    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    // Level 1: Flexible Component Wrapper
    const wrapper = result.layout[0].columns[0].component_instance;
    expect(wrapper.component_title).toBe('Flexible Component Wrapper');
    // Level 2: Composition Text 1
    const text1 = wrapper.components[0].layout[0].columns[0].component_instance;
    expect(text1.component_title).toBe('Composition Text 1');
    // Level 3: Composition Text 2
    const text2 = text1.components[0].layout[0].columns[0].component_instance;
    expect(text2.component_title).toBe('Composition Text 2');
    // Level 4: innermost composition-wrapper layout
    expect(text2.components[0].layout[0].row_title).toBe('row');
  });

  test('modal-wrapper component_instances (plural) are resolved', async () => {
    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    const modal = result.layout[1].columns[0].component_instance;
    expect(modal.component_title).toBe('Modal Composition ');

    const instances = modal.components[0].component_instances;
    expect(instances).toHaveLength(3);
    expect(instances[0].component_title).toBe('Composition Text 6');
    expect(instances[1].component_title).toBe('Navigation');
    expect(instances[2].component_title).toBe('[web][vro]footer');
  });

  // ── Single-object relation fields ───────────────────────────────────────

  test('navigation has full nested data (profile_menu, notification_data, etc.)', async () => {
    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    const nav = result.layout[2].columns[0].component_instance;
    expect(nav.component_title).toBe('Navigation');

    const navComp = nav.components[0];
    expect(navComp.__component).toBe('components.navigation');
    expect(navComp.profile_menu.menu_list).toHaveLength(5);
    expect(navComp.notification_data.heading).toBe('Alerts');
    expect(navComp.search_data.placeholder_text).toBe(
      'Search for funds, stocks, tools, etc.'
    );
    expect(navComp.mobile_nav_data.mobile_nav_links).toHaveLength(4);
    expect(navComp.logo.src).toBe('/assets/images/logos/vr-advisor-logo.svg');
  });

  // ── Deduplication ─────────────────────────────────────────────────────

  test('same CI used in multiple places gets identical resolved data', async () => {
    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    // Navigation appears at layout[2] AND inside Modal Composition's component_instances
    const navAtRoot = result.layout[2].columns[0].component_instance;
    const modalCI = result.layout[1].columns[0].component_instance;
    const navInModal = modalCI.components[0].component_instances[1];

    expect(navAtRoot.documentId).toBe(navInModal.documentId);
    expect(navAtRoot).toEqual(navInModal);
  });

  // ── Error handling ────────────────────────────────────────────────────

  test('handles missing collection entity gracefully', async () => {
    mockClient.fetchBatchByDocumentId.mockImplementationOnce((collection, docIds) => {
      const result = {};
      for (const id of docIds) {
        if (id === 'xwwazo19pcqdyadk330wq49y') {
          result[id] = null;
        } else {
          const cacheKey = `${collection}:${id}`;
          result[id] = ENTITY_MAP[cacheKey]
            ? JSON.parse(JSON.stringify(ENTITY_MAP[cacheKey]))
            : null;
        }
      }
      return Promise.resolve(result);
    });

    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    // Should return the stub instead of crashing
    const failedCI = result.layout[0].columns[0].component_instance;
    expect(failedCI.documentId).toBe('xwwazo19pcqdyadk330wq49y');
  });

  // ── Localization skipping ─────────────────────────────────────────────

  test('skips localizations field during resolution', async () => {
    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    // localizations arrays should be passed through as-is, not scanned for relations
    const wrapper = result.layout[0].columns[0].component_instance;
    expect(wrapper.localizations).toBeDefined();
  });
});
