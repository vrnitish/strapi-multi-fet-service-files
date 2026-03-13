const StrapiClient = require('../src/strapiClient');

describe('StrapiClient', () => {
  let client;

  beforeEach(() => {
    client = new StrapiClient({
      baseUrl: 'http://localhost:1337',
      token: '',
      timeout: 1000,
      collectionKeys: {
        component_instance: 'component-instances',
        component_instances: 'component-instances',
        user_types: 'user-types',
      },
    });
  });

  // ── Response merging ──────────────────────────────────────────────────────

  test('_mergeResponses keeps explicit null values from the newer payload', () => {
    const base = {
      title: 'Home',
      seo: {
        metaTitle: 'Home',
        metaDescription: 'Landing page',
      },
    };
    const update = {
      seo: {
        metaTitle: null,
      },
    };

    expect(client._mergeResponses(base, update)).toEqual({
      title: 'Home',
      seo: {
        metaTitle: null,
        metaDescription: 'Landing page',
      },
    });
  });

  test('_mergeResponses keeps explicit empty arrays from the newer payload', () => {
    const base = {
      related_articles: [{ id: 1, title: 'Old article' }],
      sections: [{ id: 1, cards: [{ id: 'a', title: 'Old card' }] }],
    };
    const update = {
      related_articles: [],
      sections: [],
    };

    expect(client._mergeResponses(base, update)).toEqual({
      related_articles: [],
      sections: [],
    });
  });

  test('_mergeResponses still preserves keys omitted from the newer payload', () => {
    const base = {
      title: 'Home',
      hero: {
        heading: 'Welcome',
        cta: {
          label: 'Explore',
        },
      },
    };
    const update = {
      hero: {
        heading: 'Updated heading',
      },
    };

    expect(client._mergeResponses(base, update)).toEqual({
      title: 'Home',
      hero: {
        heading: 'Updated heading',
        cta: {
          label: 'Explore',
        },
      },
    });
  });

  test('_mergeResponses merges non-empty arrays item by item', () => {
    const base = {
      sections: [
        {
          id: 1,
          title: 'Hero',
          cards: [{ id: 'a', title: 'Old card' }],
        },
      ],
    };
    const update = {
      sections: [
        {
          id: 1,
          cards: [{ id: 'a', title: 'New card', icon: 'star' }],
        },
      ],
    };

    expect(client._mergeResponses(base, update)).toEqual({
      sections: [
        {
          id: 1,
          title: 'Hero',
          cards: [{ id: 'a', title: 'New card', icon: 'star' }],
        },
      ],
    });
  });

  // ── Collection relation detection ─────────────────────────────────────────

  test('findCollectionRelations finds single and plural relations', () => {
    const data = {
      title: 'Page',
      component_instance: {
        id: 1,
        documentId: 'ci-1',
        component_title: 'Nav',
      },
      layout: [
        {
          columns: [
            {
              component_instance: {
                id: 2,
                documentId: 'ci-2',
                component_title: 'Footer',
              },
            },
          ],
        },
      ],
    };

    const relations = client.findCollectionRelations(data);
    const docIds = relations.map((r) => r.documentId);
    expect(docIds).toContain('ci-1');
    expect(docIds).toContain('ci-2');
    expect(relations.every((r) => r.collection === 'component-instances')).toBe(true);
  });

  test('findCollectionRelations handles plural collection relation arrays', () => {
    const data = {
      components: [
        {
          __component: 'components.modal-wrapper',
          component_instances: [
            { id: 1, documentId: 'ci-a', component_title: 'A' },
            { id: 2, documentId: 'ci-b', component_title: 'B' },
          ],
        },
      ],
    };

    const relations = client.findCollectionRelations(data);
    const docIds = relations.map((r) => r.documentId);
    expect(docIds).toContain('ci-a');
    expect(docIds).toContain('ci-b');
  });

  test('findCollectionRelations finds user_types relations', () => {
    const data = {
      auth: [
        {
          user_types: [
            { id: 1, documentId: 'ut-1', name: 'Premium' },
            { id: 2, documentId: 'ut-2', name: 'Free' },
          ],
        },
      ],
    };

    const relations = client.findCollectionRelations(data);
    expect(relations).toHaveLength(2);
    expect(relations[0].collection).toBe('user-types');
    expect(relations[1].collection).toBe('user-types');
  });

  test('findCollectionRelations recurses into localizations but not nested localizations', () => {
    const data = {
      component_instance: {
        id: 1,
        documentId: 'ci-1',
        component_title: 'Nav',
      },
      localizations: [
        {
          id: 2,
          documentId: 'loc-1',
          component_title: 'Nav',
          locale: 'hi',
          // Collection relation inside a localization entry — should be found
          component_instance: {
            id: 3,
            documentId: 'ci-2',
            component_title: 'Footer',
          },
          // Nested localizations — should NOT be recursed into
          localizations: [
            {
              id: 4,
              documentId: 'loc-2',
              component_instance: {
                id: 5,
                documentId: 'ci-3',
                component_title: 'Should not find',
              },
            },
          ],
        },
      ],
    };

    const relations = client.findCollectionRelations(data);
    const docIds = relations.map((r) => r.documentId);
    // ci-1 from root, ci-2 from inside localization entry
    expect(docIds).toContain('ci-1');
    expect(docIds).toContain('ci-2');
    // ci-3 inside nested localizations should NOT be found
    expect(docIds).not.toContain('ci-3');
  });

  test('findCollectionRelations ignores non-collection keys with documentId', () => {
    const data = {
      random_object: {
        id: 1,
        documentId: 'random-1',
        some_field: 'value',
      },
    };

    const relations = client.findCollectionRelations(data);
    expect(relations).toHaveLength(0);
  });

  // ── fetchByDocumentId with localizations ──────────────────────────────

  // ── i18n locale discovery ─────────────────────────────────────────────────

  test('_fetchLocales returns locale codes and caches the result', async () => {
    client.http.get = jest.fn().mockResolvedValue({
      data: [{ code: 'en', name: 'English' }, { code: 'hi', name: 'Hindi' }],
    });

    const first = await client._fetchLocales();
    const second = await client._fetchLocales(); // must use cache

    expect(first).toEqual(['en', 'hi']);
    expect(second).toBe(first); // same reference — cached
    expect(client.http.get).toHaveBeenCalledTimes(1);
  });

  test('_fetchLocales returns [] when API call fails', async () => {
    client.http.get = jest.fn().mockRejectedValue(new Error('not found'));
    const result = await client._fetchLocales();
    expect(result).toEqual([]);
  });

  // ── fetchByDocumentId with localizations ──────────────────────────────

  test('fetchByDocumentId fully populates localizations via i18n locales API (Phase 4)', async () => {
    const calls = [];

    client.http.get = jest.fn().mockImplementation((url) => {
      calls.push(decodeURIComponent(url));

      // i18n locales endpoint
      if (url.includes('/api/i18n/locales')) {
        return Promise.resolve({ data: [{ code: 'en' }, { code: 'hi' }] });
      }

      // Entity fetch — returns different data per locale, no localizations field
      const isHi = url.includes('locale=hi');
      return Promise.resolve({
        data: {
          data: {
            id: isHi ? 2 : 1,
            documentId: 'ci-1',
            component_title: 'Nav',
            locale: isHi ? 'hi' : 'en',
            greeting: isHi ? 'namaste' : 'Hello',
            localizations: [], // Strapi v5 often returns [] here
          },
        },
      });
    });

    const result = await client.fetchByDocumentId('component-instances', 'ci-1', 'en');

    // Main entity
    expect(result.locale).toBe('en');
    expect(result.greeting).toBe('Hello');

    // Phase 4 used /api/i18n/locales to discover 'hi' and fetched it
    expect(result.localizations).toHaveLength(1);
    expect(result.localizations[0].locale).toBe('hi');
    expect(result.localizations[0].greeting).toBe('namaste');

    // Locales API was called
    const localesCalls = calls.filter((url) => url.includes('/api/i18n/locales'));
    expect(localesCalls.length).toBeGreaterThan(0);

    // Phase 4 fetched hi locale
    const hiCalls = calls.filter((url) => url.includes('locale=hi'));
    expect(hiCalls.length).toBeGreaterThan(0);
  });

  test('fetchByDocumentId skips Phase 4 when resolveLocalizations is false', async () => {
    const calls = [];

    client.http.get = jest.fn().mockImplementation((url) => {
      calls.push(decodeURIComponent(url));

      if (url.includes('/api/i18n/locales')) {
        return Promise.resolve({ data: [{ code: 'en' }, { code: 'hi' }] });
      }

      return Promise.resolve({
        data: {
          data: {
            id: 1,
            documentId: 'ci-1',
            component_title: 'Nav',
            locale: 'en',
            localizations: [],
          },
        },
      });
    });

    const result = await client.fetchByDocumentId(
      'component-instances', 'ci-1', 'en',
      { resolveLocalizations: false }
    );

    // localizations should be whatever Strapi returned (empty in this case)
    expect(result.localizations).toEqual([]);

    // No hi-locale calls (Phase 4 was skipped)
    const hiCalls = calls.filter((url) => url.includes('locale=hi'));
    expect(hiCalls).toHaveLength(0);

    // Locales API was NOT called
    const localesCalls = calls.filter((url) => url.includes('/api/i18n/locales'));
    expect(localesCalls).toHaveLength(0);
  });

  // ── Page-level localization resolution ───────────────────────────────────

  test('fetchEntry populates page-level localizations via i18n locales API', async () => {
    const calls = [];

    client.http.get = jest.fn().mockImplementation((url) => {
      calls.push(decodeURIComponent(url));

      if (url.includes('/api/i18n/locales')) {
        return Promise.resolve({ data: [{ code: 'en' }, { code: 'hi' }] });
      }

      // Collection list fetch (has filters query params)
      if (url.includes('/api/pages?')) {
        return Promise.resolve({
          data: {
            data: [{
              id: 1,
              documentId: 'page-1',
              title: 'Home',
              locale: 'en',
              localizations: [], // Strapi returns [] here
            }],
            meta: { pagination: { page: 1, pageCount: 1, pageSize: 1, total: 1 } },
          },
        });
      }

      // Single document fetch by documentId
      if (url.includes('/api/pages/page-1')) {
        const isHi = url.includes('locale=hi');
        return Promise.resolve({
          data: {
            data: {
              id: isHi ? 2 : 1,
              documentId: 'page-1',
              title: isHi ? 'होम' : 'Home',
              locale: isHi ? 'hi' : 'en',
              seo: { metaTitle: isHi ? 'होम पेज' : 'Home Page' },
              localizations: [],
            },
          },
        });
      }

      return Promise.resolve({ data: { data: null } });
    });

    const result = await client.fetchEntry('pages', {
      filters: { slug: '/' },
      locale: 'en',
    });

    // Main entry
    expect(result.locale).toBe('en');
    expect(result.title).toBe('Home');

    // Phase 3 used locales API to discover 'hi' and fetched the page in hi locale
    expect(result.localizations).toHaveLength(1);
    expect(result.localizations[0].locale).toBe('hi');
    expect(result.localizations[0].title).toBe('होम');
    expect(result.localizations[0].seo).toEqual({ metaTitle: 'होम पेज' });

    // Locales API and hi-locale calls were made
    const hiCalls = calls.filter((url) => url.includes('locale=hi'));
    expect(hiCalls.length).toBeGreaterThan(0);
  });

  // ── Batch fetch ──────────────────────────────────────────────────────────

  test('fetchBatchByDocumentId fetches multiple in parallel', async () => {
    client.http.get = jest.fn().mockImplementation((url) => {
      // i18n locales — return empty so no localization fetches are made
      if (url.includes('/api/i18n/locales')) {
        return Promise.resolve({ data: [] });
      }
      const docId = url.match(/\/([^/?]+)\?/)?.[1];
      return Promise.resolve({
        data: {
          data: {
            id: 1,
            documentId: docId,
            component_title: `Component ${docId}`,
          },
        },
      });
    });

    const result = await client.fetchBatchByDocumentId(
      'component-instances',
      ['ci-1', 'ci-2'],
      'en'
    );

    expect(result['ci-1'].documentId).toBe('ci-1');
    expect(result['ci-2'].documentId).toBe('ci-2');
    // Each fetchByDocumentId makes 1 Phase-1 request (populate=*)
    // plus 1 shared/cached i18n/locales call → 2×1 + 1 = 3
    expect(client.http.get).toHaveBeenCalledTimes(3);
  });

  // ── _mergeEntriesById ────────────────────────────────────────────────────

  test('_mergeEntriesById merges matching entries by documentId', () => {
    const existing = [
      { documentId: 'a', title: 'Old A', extra: 'keep' },
      { documentId: 'b', title: 'Old B' },
    ];
    const incoming = [
      { documentId: 'a', title: 'New A', newField: 'added' },
      { documentId: 'c', title: 'C (not in existing)' },
    ];
    const result = client._mergeEntriesById(existing, incoming);
    expect(result[0].title).toBe('New A');
    expect(result[0].extra).toBe('keep');
    expect(result[0].newField).toBe('added');
    expect(result[1].title).toBe('Old B');
    expect(result).toHaveLength(2);
  });

  // ── proxyGet ──────────────────────────────────────────────────────────────

  test('proxyGet forwards request directly to Strapi with query string', async () => {
    client.http.get = jest.fn().mockResolvedValue({ data: { data: [{ id: 1 }] } });
    const result = await client.proxyGet('/api/pages', 'locale=en&sort=title');
    expect(client.http.get).toHaveBeenCalledWith('/api/pages?locale=en&sort=title');
    expect(result).toEqual({ data: [{ id: 1 }] });
  });

  test('proxyGet works without query string', async () => {
    client.http.get = jest.fn().mockResolvedValue({ data: { items: [] } });
    const result = await client.proxyGet('/api/pages', '');
    expect(client.http.get).toHaveBeenCalledWith('/api/pages');
    expect(result).toEqual({ items: [] });
  });

  // ── _fetchEntryEnvelope with rawQuery ────────────────────────────────────

  test('_fetchEntryEnvelope uses rawQuery as base params when provided', async () => {
    const calls = [];
    client.http.get = jest.fn().mockImplementation((url) => {
      calls.push(decodeURIComponent(url));
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: {
          data: { id: 1, documentId: 'page-1', title: 'Home', locale: 'en' },
          meta: { pagination: { page: 1, pageCount: 1, pageSize: 1, total: 1 } },
        },
      });
    });

    await client.fetchEntry('pages', { rawQuery: 'locale=fr&sort=title:asc' });

    const phase1Call = calls.find((url) => url.includes('populate=*'));
    expect(phase1Call).toContain('locale=fr');
    expect(phase1Call).toContain('sort=title:asc');
  });

  // ── _fetchEntryEnvelope no entry found ───────────────────────────────────

  test('fetchEntry throws when no entry is found', async () => {
    client.http.get = jest.fn().mockResolvedValue({
      data: { data: null, meta: {} },
    });
    await expect(client.fetchEntry('pages', { filters: { slug: '/missing/' } }))
      .rejects.toThrow('No entry found');
  });

  // ── _fetchEntryEnvelope alwaysPopulateFields ──────────────────────────────

  test('_fetchEntryEnvelope fetches alwaysPopulateFields missing from Phase 1', async () => {
    const clientWithAlways = new StrapiClient({
      baseUrl: 'http://localhost:1337',
      token: '',
      alwaysPopulateFields: ['seo_elements'],
    });

    const calls = [];
    clientWithAlways.http.get = jest.fn().mockImplementation((url) => {
      calls.push(decodeURIComponent(url));
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: {
          data: { id: 1, documentId: 'page-1', title: 'Home' },
          meta: { pagination: {} },
        },
      });
    });

    await clientWithAlways.fetchEntry('pages', { filters: { slug: '/' } });

    const p1bCall = calls.find((url) => url.includes('populate[seo_elements]'));
    expect(p1bCall).toBeTruthy();
  });

  // ── fetchByDocumentId alwaysPopulateFields ───────────────────────────────

  test('fetchByDocumentId fetches alwaysPopulateFields missing from Phase 1', async () => {
    const clientWithAlways = new StrapiClient({
      baseUrl: 'http://localhost:1337',
      token: '',
      alwaysPopulateFields: ['seo_elements'],
    });

    const calls = [];
    clientWithAlways.http.get = jest.fn().mockImplementation((url) => {
      calls.push(decodeURIComponent(url));
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: { data: { id: 1, documentId: 'ci-1', title: 'Nav' } },
      });
    });

    await clientWithAlways.fetchByDocumentId('component-instances', 'ci-1', 'en');

    const p1bCall = calls.find((url) => url.includes('populate[seo_elements]'));
    expect(p1bCall).toBeTruthy();
  });

  // ── fetchByDocumentId zone populate ─────────────────────────────────────

  test('fetchByDocumentId runs zone populate when components field exists', async () => {
    const calls = [];
    client.http.get = jest.fn().mockImplementation((url) => {
      calls.push(decodeURIComponent(url));
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: {
          data: {
            id: 1,
            documentId: 'ci-1',
            component_title: 'Nav',
            components: [
              { __component: 'components.nav', title: 'Nav bar' },
            ],
          },
        },
      });
    });

    await client.fetchByDocumentId('component-instances', 'ci-1', 'en');

    const zoneCall = calls.find((url) => url.includes('populate[components][populate]'));
    expect(zoneCall).toBeTruthy();
  });

  // ── fetchBatchByDocumentId empty array ───────────────────────────────────

  test('fetchBatchByDocumentId returns empty object for empty input', async () => {
    client.http.get = jest.fn();
    const result = await client.fetchBatchByDocumentId('component-instances', [], 'en');
    expect(result).toEqual({});
    expect(client.http.get).not.toHaveBeenCalled();
  });

  // ── fetchBatchByDocumentId error handling ────────────────────────────────

  test('fetchBatchByDocumentId throws if any individual fetch fails', async () => {
    client.http.get = jest.fn().mockImplementation((url) => {
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      if (url.includes('ci-bad')) return Promise.reject(new Error('Network error'));
      return Promise.resolve({
        data: { data: { id: 1, documentId: 'ci-good', component_title: 'Good' } },
      });
    });

    await expect(
      client.fetchBatchByDocumentId('component-instances', ['ci-good', 'ci-bad'], 'en')
    ).rejects.toThrow('Partial fetch failure');
  });

  // ── _mergeResponses edge cases ───────────────────────────────────────────

  test('_mergeResponses handles undefined inputs', () => {
    expect(client._mergeResponses(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(client._mergeResponses({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test('_mergeResponses handles primitive vs object', () => {
    expect(client._mergeResponses('old', 'new')).toBe('new');
    expect(client._mergeResponses(null, { a: 1 })).toEqual({ a: 1 });
    expect(client._mergeResponses({ a: 1 }, null)).toBeNull();
  });

  test('_mergeResponses handles array vs non-array mismatch', () => {
    expect(client._mergeResponses([1, 2], 'string')).toBe('string');
    expect(client._mergeResponses('string', [1, 2])).toEqual([1, 2]);
  });

  // ── fetchEntry iterative deepening ───────────────────────────────────────

  test('_fetchEntryEnvelope runs iterative deepening passes until convergence', async () => {
    let passCount = 0;
    client.http.get = jest.fn().mockImplementation((url) => {
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });

      passCount++;
      if (passCount === 1) {
        return Promise.resolve({
          data: {
            data: {
              id: 1, documentId: 'page-1', title: 'Home',
              section: { id: 2, documentId: 'sec-1' },
            },
            meta: { pagination: {} },
          },
        });
      }
      return Promise.resolve({
        data: {
          data: {
            id: 1, documentId: 'page-1', title: 'Home',
            section: { id: 2, documentId: 'sec-1', heading: 'Hero' },
          },
          meta: { pagination: {} },
        },
      });
    });

    const result = await client.fetchEntry('pages', { filters: { slug: '/' } });
    const collectionCalls = client.http.get.mock.calls
      .map((c) => c[0])
      .filter((url) => url.includes('/api/pages'));
    expect(collectionCalls.length).toBeGreaterThanOrEqual(2);
    expect(result.section.heading).toBe('Hero');
  });

  // ── fetchEntryWithMeta ───────────────────────────────────────────────────

  test('fetchEntryWithMeta returns entry and meta together', async () => {
    client.http.get = jest.fn().mockImplementation((url) => {
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: {
          data: { id: 1, documentId: 'page-1', title: 'Home', locale: 'en' },
          meta: { pagination: { page: 1, pageCount: 1, pageSize: 25, total: 1 } },
        },
      });
    });

    const result = await client.fetchEntryWithMeta('pages', { filters: { slug: '/' }, locale: 'en' });
    expect(result.entry).toBeDefined();
    expect(result.meta.pagination.total).toBe(1);
  });

  // ── fetchByDocumentId non-zone iterative deepening ───────────────────────

  test('fetchByDocumentId runs non-zone deepening passes when stubs are present', async () => {
    let callCount = 0;
    client.http.get = jest.fn().mockImplementation((url) => {
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      callCount++;
      if (callCount === 1) {
        // Phase 1: entity with a stub (no components zone)
        return Promise.resolve({
          data: {
            data: {
              id: 1, documentId: 'ci-1', component_title: 'Nav',
              profile: { id: 2, documentId: 'profile-1' }, // stub — only system keys
            },
          },
        });
      }
      // Non-zone deepening pass: return fully populated
      return Promise.resolve({
        data: {
          data: {
            id: 1, documentId: 'ci-1', component_title: 'Nav',
            profile: { id: 2, documentId: 'profile-1', heading: 'My Profile' },
          },
        },
      });
    });

    const result = await client.fetchByDocumentId('component-instances', 'ci-1', 'en');
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(result.profile.heading).toBe('My Profile');
  });

  // ── fetchByDocumentId Fragment API deepening ─────────────────────────────

  test('fetchByDocumentId runs Fragment API deepening for dynamic zones with stubs', async () => {
    let callCount = 0;
    client.http.get = jest.fn().mockImplementation((url) => {
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      callCount++;
      if (callCount === 1) {
        // Phase 1: has components zone but shallow
        return Promise.resolve({
          data: {
            data: {
              id: 1, documentId: 'ci-1', component_title: 'Wrapper',
              components: [{ __component: 'components.nav', title: 'Nav bar' }],
            },
          },
        });
      }
      if (callCount === 2) {
        // Zone populate: zone items now have a stub nested inside
        return Promise.resolve({
          data: {
            data: {
              id: 1, documentId: 'ci-1', component_title: 'Wrapper',
              components: [{
                __component: 'components.nav', title: 'Nav bar',
                rows: [{ title: 'Row', link: { id: 3, documentId: 'link-1' } }],
              }],
            },
          },
        });
      }
      // Fragment deepening: fully populated
      return Promise.resolve({
        data: {
          data: {
            id: 1, documentId: 'ci-1', component_title: 'Wrapper',
            components: [{
              __component: 'components.nav', title: 'Nav bar',
              rows: [{ title: 'Row', link: { id: 3, documentId: 'link-1', href: '/about' } }],
            }],
          },
        },
      });
    });

    const result = await client.fetchByDocumentId('component-instances', 'ci-1', 'en');
    // Fragment deepening pass must have run
    expect(callCount).toBeGreaterThanOrEqual(3);
    const calls = client.http.get.mock.calls.map((c) => decodeURIComponent(c[0]));
    expect(calls.some((u) => u.includes('populate[components][on]'))).toBe(true);
  });

  // ── _restoreLocalizations in fetchByDocumentId ───────────────────────────

  test('fetchByDocumentId restores localizations wiped by zone populate', async () => {
    let callCount = 0;
    client.http.get = jest.fn().mockImplementation((url) => {
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      callCount++;
      if (callCount === 1) {
        // Phase 1: has localizations + components zone
        return Promise.resolve({
          data: {
            data: {
              id: 1, documentId: 'ci-1', component_title: 'Nav',
              localizations: [{ id: 2, documentId: 'ci-1-hi', locale: 'hi' }],
              components: [{ __component: 'components.nav', title: 'Nav bar' }],
            },
          },
        });
      }
      // Zone populate wipes localizations
      return Promise.resolve({
        data: {
          data: {
            id: 1, documentId: 'ci-1', component_title: 'Nav',
            localizations: [], // wiped
            components: [{ __component: 'components.nav', title: 'Nav bar' }],
          },
        },
      });
    });

    const result = await client.fetchByDocumentId('component-instances', 'ci-1', 'en', {
      resolveLocalizations: false,
    });
    // _restoreLocalizations should have restored the saved localizations
    expect(result.localizations).toHaveLength(1);
    expect(result.localizations[0].locale).toBe('hi');
  });

  // ── localization restoration in _fetchEntryEnvelope ─────────────────────

  test('_fetchEntryEnvelope restores localizations wiped by iterative deepening', async () => {
    let callCount = 0;
    client.http.get = jest.fn().mockImplementation((url) => {
      if (url.includes('/api/i18n/locales')) return Promise.resolve({ data: [] });
      callCount++;
      const meta = { pagination: { page: 1, pageCount: 1, pageSize: 1, total: 1 } };
      if (callCount === 1) {
        // Phase 1: entry has localizations + a stub
        return Promise.resolve({
          data: {
            data: {
              id: 1, documentId: 'page-1', title: 'Home',
              localizations: [{ id: 2, documentId: 'page-1-hi', locale: 'hi', title: 'होम' }],
              section: { id: 2, documentId: 'sec-1' }, // stub
            },
            meta,
          },
        });
      }
      // Deepening: localizations wiped
      return Promise.resolve({
        data: {
          data: {
            id: 1, documentId: 'page-1', title: 'Home',
            localizations: [], // wiped by deepening
            section: { id: 2, documentId: 'sec-1', heading: 'Hero' },
          },
          meta,
        },
      });
    });

    const result = await client.fetchEntry('pages', {
      filters: { slug: '/' },
      maxDepth: 2, // finite depth so Phase 3 locale fetch is skipped
    });
    // localizations should be restored from Phase 1 data
    expect(result.localizations).toHaveLength(1);
    expect(result.localizations[0].locale).toBe('hi');
  });
});
