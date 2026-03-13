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
});
