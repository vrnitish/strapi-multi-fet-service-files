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

// ── Helpers to derive mock data from valid.json ─────────────────────────────

const SKIP_KEYS = new Set(['localizations']);

function isCIEntity(obj) {
  return (
    obj != null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    typeof obj.documentId === 'string' &&
    'component_title' in obj
  );
}

function toStub(ci) {
  return { id: ci.id, documentId: ci.documentId, component_title: ci.component_title };
}

/**
 * Walk the fully-resolved page, replace every CI entity with a stub,
 * and collect each CI's data (with its own nested CIs also stubified).
 */
function buildMocksFromValid(fullPage) {
  const ciMap = {};
  const pageShell = _replaceCIs(fullPage, ciMap);
  return { pageShell, ciMap };
}

function _replaceCIs(node, ciMap) {
  if (!node || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => {
      if (isCIEntity(item)) {
        _collectCI(item, ciMap);
        return toStub(item);
      }
      return _replaceCIs(item, ciMap);
    });
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) {
      result[key] = value;
      continue;
    }
    if (isCIEntity(value)) {
      _collectCI(value, ciMap);
      result[key] = toStub(value);
    } else {
      result[key] = _replaceCIs(value, ciMap);
    }
  }
  return result;
}

function _collectCI(ci, ciMap) {
  if (ci.documentId in ciMap) return;
  ciMap[ci.documentId] = null; // reserve slot to prevent re-entry
  const ciData = {};
  for (const [key, value] of Object.entries(ci)) {
    if (SKIP_KEYS.has(key)) {
      ciData[key] = value;
      continue;
    }
    ciData[key] = _replaceCIs(value, ciMap);
  }
  ciMap[ci.documentId] = ciData;
}

// ── Build mock data + expected output ────────────────────────────────────────

const { pageShell: PAGE_SHELL, ciMap: CI_MAP } = buildMocksFromValid(EXPECTED_PAGE);

/**
 * Build the expected resolved output by replacing stubs with ciMap data,
 * recursively. This accounts for the resolver's deduplication: the same CI
 * documentId always gets the same cached data everywhere in the tree
 * (valid.json may have location-specific differences like localizations).
 */
function buildExpected(shell, ciMap) {
  const cache = {};
  return _resolveNode(JSON.parse(JSON.stringify(shell)), ciMap, cache);
}

function _resolveNode(node, ciMap, cache) {
  if (!node || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => {
      if (isCIEntity(item) && ciMap[item.documentId]) {
        return _resolvedCI(item.documentId, ciMap, cache);
      }
      return _resolveNode(item, ciMap, cache);
    });
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) {
      result[key] = value;
      continue;
    }
    if (isCIEntity(value) && ciMap[value.documentId]) {
      result[key] = _resolvedCI(value.documentId, ciMap, cache);
    } else {
      result[key] = _resolveNode(value, ciMap, cache);
    }
  }
  return result;
}

function _resolvedCI(docId, ciMap, cache) {
  if (docId in cache) return cache[docId];
  cache[docId] = null; // reserve to prevent cycles
  cache[docId] = _resolveNode(JSON.parse(JSON.stringify(ciMap[docId])), ciMap, cache);
  return cache[docId];
}

const RESOLVED_EXPECTED = buildExpected(PAGE_SHELL, CI_MAP);

function createMockClient() {
  return {
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
    fetchComponentInstancesBatch: jest.fn().mockImplementation((docIds) => {
      const result = {};
      for (const id of docIds) {
        result[id] = CI_MAP[id] ? JSON.parse(JSON.stringify(CI_MAP[id])) : null;
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
    const result = await resolver.resolveWithMeta('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');

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

  // ── CI stub detection ───────────────────────────────────────────────────

  test('collects all top-level CI stubs from page shell', () => {
    const stubs = resolver._findAllCIStubs(PAGE_SHELL);
    const docIds = stubs.map((s) => s.documentId);
    expect(docIds).toContain('xwwazo19pcqdyadk330wq49y'); // Flexible Component Wrapper
    expect(docIds).toContain('mviok539521jomdcx29pk2dc'); // Modal Composition
    expect(docIds).toContain('kgrda2v2o52q6qzeus8hu3l7'); // Navigation
  });

  test('resolves all 7 unique component instances', async () => {
    await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    const allFetchedIds = new Set();
    for (const call of mockClient.fetchComponentInstancesBatch.mock.calls) {
      for (const id of call[0]) allFetchedIds.add(id);
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

  test('deduplicates stubs found in multiple locations', () => {
    const dataWithDuplicates = {
      layout: [
        {
          columns: [
            { component_instance: { id: 1, documentId: 'aaa', component_title: 'A' } },
            { component_instance: { id: 1, documentId: 'aaa', component_title: 'A' } },
          ],
        },
      ],
    };
    const stubs = resolver._findAllCIStubs(dataWithDuplicates);
    // _findAllCIStubs finds all occurrences; deduplication happens in _deepResolve
    expect(stubs).toHaveLength(2);
    expect(stubs[0].documentId).toBe('aaa');
  });

  // ── Error handling ────────────────────────────────────────────────────

  test('handles missing component instance gracefully', async () => {
    mockClient.fetchComponentInstancesBatch.mockImplementationOnce((docIds) => {
      const result = {};
      for (const id of docIds) {
        result[id] =
          id === 'xwwazo19pcqdyadk330wq49y'
            ? null
            : CI_MAP[id]
            ? JSON.parse(JSON.stringify(CI_MAP[id]))
            : null;
      }
      return Promise.resolve(result);
    });

    const result = await resolver.resolve('pages', { slug: '/dynamic/{{dynamic}}/' }, 'en');
    // Should return the stub instead of crashing
    const failedCI = result.layout[0].columns[0].component_instance;
    expect(failedCI.documentId).toBe('xwwazo19pcqdyadk330wq49y');
    expect(failedCI.components).toBeUndefined();
  });

  // ── Shape-based detection ─────────────────────────────────────────────

  test('detects CI entities under any field name (shape-based)', () => {
    const data = {
      some_random_field: {
        id: 99,
        documentId: 'xyz123',
        component_title: 'Custom Widget',
      },
      another_field: [
        { id: 100, documentId: 'abc456', component_title: 'Footer' },
        { id: 101, documentId: 'def789', component_title: 'Header' },
      ],
    };
    const stubs = resolver._findAllCIStubs(data);
    expect(stubs).toHaveLength(3);
    expect(stubs.map((s) => s.documentId)).toEqual(
      expect.arrayContaining(['xyz123', 'abc456', 'def789'])
    );
  });

  test('finds stubs in root arrays and returns early for null or visited data', () => {
    const seen = { component_instance: { id: 1, documentId: 'seen', component_title: 'Seen' } };
    const visited = new WeakSet([seen]);

    expect(resolver._findAllCIStubs(null)).toEqual([]);
    expect(resolver._findAllCIStubs(seen, visited)).toEqual([]);

    const data = [
      { id: 10, documentId: 'root-ci', component_title: 'Root CI' },
      {
        nested_items: [
          { id: 11, documentId: 'nested-ci', component_title: 'Nested CI' },
          42,
          {
            deep: {
              id: 12,
              documentId: 'deep-ci',
              component_title: 'Deep CI',
            },
          },
        ],
      },
    ];

    const stubs = resolver._findAllCIStubs(data);

    expect(stubs.map((stub) => stub.documentId)).toEqual([
      'root-ci',
      'nested-ci',
      'deep-ci',
    ]);
  });

  test('replaces stubs in root arrays and preserves unresolved array items', () => {
    const seen = { any: 'value' };
    const visited = new WeakSet([seen]);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolver._replaceCIStubs(null, {})).toBeNull();
    expect(resolver._replaceCIStubs(seen, {}, visited)).toBe(seen);

    const rootResolvedStub = {
      id: 20,
      documentId: 'root-resolved',
      component_title: 'Root Resolved',
    };
    const rootMissingStub = {
      id: 21,
      documentId: 'root-missing',
      component_title: 'Root Missing',
    };
    const nestedMissingStub = {
      id: 22,
      documentId: 'nested-missing',
      component_title: 'Nested Missing',
    };
    const resolvedPayload = {
      id: 20,
      documentId: 'root-resolved',
      component_title: 'Root Resolved',
      components: [{ label: 'resolved' }],
    };

    const result = resolver._replaceCIStubs(
      [
        rootResolvedStub,
        rootMissingStub,
        {
          nested_items: [
            nestedMissingStub,
            {
              child: rootResolvedStub,
            },
          ],
        },
      ],
      {
        'root-resolved': resolvedPayload,
        'root-missing': null,
        'nested-missing': null,
      }
    );

    expect(result[0]).toEqual(resolvedPayload);
    expect(result[1]).toBe(rootMissingStub);
    expect(result[2].nested_items[0]).toBe(nestedMissingStub);
    expect(result[2].nested_items[1].child).toEqual(resolvedPayload);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Resolver] Missing data for component: root-missing'
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[Resolver] Missing data for component: nested-missing'
    );

    warnSpy.mockRestore();
  });

  test('skips localizations even though they have component_title', () => {
    const data = {
      component_instance: {
        id: 1,
        documentId: 'real-ci',
        component_title: 'Real CI',
      },
      localizations: [
        { id: 2, documentId: 'real-ci', component_title: 'Real CI', locale: 'hi' },
      ],
    };
    const stubs = resolver._findAllCIStubs(data);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].documentId).toBe('real-ci');
  });

  test('supports configurable entity and localization field names', () => {
    const customResolver = new PageResolver(
      {
        entityLabelField: 'title_field',
        localizationField: 'translations',
      },
      {
        entityLabelField: 'title_field',
        localizationField: 'translations',
      }
    );
    const data = {
      relation_a: {
        id: 1,
        documentId: 'custom-ci',
        title_field: 'Custom CI',
      },
      translations: [
        {
          id: 2,
          documentId: 'custom-ci',
          title_field: 'Localized variant',
          locale: 'hi',
        },
      ],
    };

    const stubs = customResolver._findAllCIStubs(data);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].documentId).toBe('custom-ci');
  });
});
