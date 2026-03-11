const StrapiClient = require('../src/strapiClient');

describe('StrapiClient', () => {
  let client;

  beforeEach(() => {
    client = new StrapiClient({
      baseUrl: 'http://localhost:1337',
      token: '',
      timeout: 1000,
    });
  });

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

  test('fetchEntryWithMeta preserves top-level meta and repopulates localizations', async () => {
    client.maxPopulatePasses = 1;
    client.http.get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              id: 1,
              documentId: 'page-1',
              title: 'Home',
            },
          ],
          meta: {
            pagination: {
              page: 1,
              pageCount: 1,
              pageSize: 25,
              total: 1,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              id: 1,
              documentId: 'page-1',
              title: 'Home',
              localizations: [{ id: 2, documentId: 'page-2', locale: 'hi' }],
            },
          ],
        },
      });

    const result = await client.fetchEntryWithMeta('pages', {
      filters: { slug: '/home/' },
      locale: 'en',
    });

    expect(result).toEqual({
      entry: {
        id: 1,
        documentId: 'page-1',
        title: 'Home',
        localizations: [{ id: 2, documentId: 'page-2', locale: 'hi' }],
      },
      meta: {
        pagination: {
          page: 1,
          pageCount: 1,
          pageSize: 25,
          total: 1,
        },
      },
    });
    expect(client.http.get.mock.calls[1][0]).toContain('populate%5Blocalizations%5D=*');
  });

  test('fetchComponentInstance explicitly populates localizations', async () => {
    client.maxPopulatePasses = 1;
    client.http.get = jest.fn().mockResolvedValue({
      data: {
        data: {
          id: 1,
          documentId: 'ci-1',
          components: [],
          localizations: [{ id: 2, documentId: 'ci-2', locale: 'hi' }],
        },
      },
    });

    const result = await client.fetchComponentInstance('ci-1', 'en');

    expect(result.localizations).toEqual([{ id: 2, documentId: 'ci-2', locale: 'hi' }]);
    // Phase 1 (broad) includes localizations populate
    expect(client.http.get.mock.calls[0][0]).toContain('populate%5Blocalizations%5D=*');
    // Phase 2 (zone) also includes localizations populate
    expect(client.http.get.mock.calls[1][0]).toContain('populate%5Blocalizations%5D=*');
    expect(client.http.get.mock.calls[1][0]).toContain('populate%5Bcomponents%5D%5Bpopulate%5D=*');
  });

  test('supports configurable schema field names and collection names', async () => {
    const customClient = new StrapiClient({
      baseUrl: 'http://localhost:1337',
      token: '',
      timeout: 1000,
      localizationField: 'translations',
      componentTypeField: 'kind',
      componentZoneField: 'blocks',
      componentCollection: 'widgets',
    });

    customClient.maxPopulatePasses = 1;
    customClient.http.get = jest.fn().mockResolvedValue({
      data: {
        data: {
          id: 1,
          documentId: 'widget-1',
          blocks: [],
          translations: [{ id: 2, documentId: 'widget-2', locale: 'hi' }],
        },
      },
    });

    const result = await customClient.fetchComponentInstance('widget-1', 'en');

    expect(result.translations).toEqual([{ id: 2, documentId: 'widget-2', locale: 'hi' }]);
    // Phase 1: broad populate=*
    expect(customClient.http.get.mock.calls[0][0]).toContain('/api/widgets/widget-1?');
    expect(customClient.http.get.mock.calls[0][0]).toContain('populate=*');
    expect(customClient.http.get.mock.calls[0][0]).toContain('populate%5Btranslations%5D=*');
    // Phase 2: zone-specific populate
    expect(customClient.http.get.mock.calls[1][0]).toContain('populate%5Bblocks%5D%5Bpopulate%5D=*');
    expect(customClient.http.get.mock.calls[1][0]).toContain('populate%5Btranslations%5D=*');
  });
});
