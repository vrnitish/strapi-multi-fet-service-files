const {
  collectDeepPaths,
  collectStubPaths,
  buildFragmentDeepPathEntries,
  buildDeepPopulateParams,
  shouldStopAtValue,
} = require('../src/deepPopulate');

describe('deepPopulate generic boundaries', () => {
  test('stops at component-like objects by shape, not by field name', () => {
    const data = {
      layout: [
        {
          columns: [
            {
              surprise_relation: {
                id: 10,
                documentId: 'ci-10',
                component_title: 'Hero Banner',
                nested: { should_not: 'be scanned here' },
              },
            },
          ],
        },
      ],
    };

    expect(collectDeepPaths(data)).toEqual([['layout'], ['layout', 'columns']]);
  });

  test('stops at arrays of component-like objects regardless of field name', () => {
    const data = {
      sections: [
        {
          cards: [
            {
              unexpected_list: [
                { id: 1, documentId: 'ci-a', component_title: 'A' },
                { id: 2, documentId: 'ci-b', component_title: 'B' },
              ],
            },
          ],
        },
      ],
    };

    expect(collectDeepPaths(data)).toEqual([['sections'], ['sections', 'cards']]);
    expect(shouldStopAtValue(data.sections[0].cards[0].unexpected_list)).toBe(true);
  });

  test('fragment deepening avoids hardcoded relation names', () => {
    const entries = buildFragmentDeepPathEntries([
      {
        __component: 'components.wrapper',
        rows: [
          {
            arbitrary_child: {
              id: 11,
              documentId: 'ci-11',
              component_title: 'Nested Component',
            },
          },
        ],
      },
    ]);

    expect(entries).toEqual([
      ['populate[components][on][components.wrapper][populate][rows][populate]', '*'],
    ]);
  });

  test('supports custom schema field names', () => {
    const schema = {
      entityLabelField: 'title_field',
      componentTypeField: 'kind',
    };
    const data = {
      rows: [
        {
          unknown_relation: {
            id: 20,
            documentId: 'custom-20',
            title_field: 'Custom marker',
          },
        },
      ],
    };

    expect(collectDeepPaths(data, { schema })).toEqual([['rows']]);
    expect(
      buildFragmentDeepPathEntries(
        [
          {
            kind: 'components.wrapper',
            rows: [
              {
                unknown_relation: {
                  id: 21,
                  documentId: 'custom-21',
                  title_field: 'Nested marker',
                },
              },
            ],
          },
        ],
        schema
      )
    ).toEqual([
      ['populate[components][on][components.wrapper][populate][rows][populate]', '*'],
    ]);
  });

  // ── collectStubPaths line-level coverage ─────────────────────────────────

  test('collectStubPaths: localization array of stubs pushes path (line 136)', () => {
    const data = { localizations: [{ id: 1, documentId: 'loc-1' }] };
    const result = collectStubPaths(data);
    expect(result).toContainEqual(['localizations']);
  });

  test('collectStubPaths: array where every item is a stub pushes path (line 144)', () => {
    const data = {
      items: [
        { id: 1, documentId: 'ci-1' },
        { id: 2, documentId: 'ci-2' },
      ],
    };
    const result = collectStubPaths(data);
    expect(result).toContainEqual(['items']);
  });

  test('collectStubPaths: single stub object pushes path (lines 149-150)', () => {
    const data = { relation: { id: 1, documentId: 'ci-1' } };
    const result = collectStubPaths(data);
    expect(result).toContainEqual(['relation']);
  });

  test('collectStubPaths: single real object recurses into it (line 152)', () => {
    const data = {
      wrapper: {
        title: 'hello',
        inner: { id: 1, documentId: 'ci-1' },
      },
    };
    const result = collectStubPaths(data);
    expect(result).toContainEqual(['wrapper', 'inner']);
  });

  // ── collectDeepPaths line-level coverage ─────────────────────────────────

  test('collectDeepPaths: array passed directly — recurses each item (lines 187-190)', () => {
    const data = [
      {
        profile: {
          heading: 'Hi',
          inner: { id: 1, documentId: 'ci-1', component_title: 'Nav' },
        },
      },
    ];
    const result = collectDeepPaths(data, { stopAtEntities: false });
    expect(result).toContainEqual(['profile']);
  });

  test('collectDeepPaths: localization with real populated items pushes path (lines 208, 211)', () => {
    const data = {
      localizations: [
        { id: 1, documentId: 'loc-1', title: 'French', locale: 'fr' },
      ],
    };
    const result = collectDeepPaths(data);
    expect(result).toContainEqual(['localizations']);
  });

  test('collectDeepPaths: single real object pushes path AND recurses (lines 230-231)', () => {
    const data = {
      seo: {
        metaTitle: 'Home',
        image: { url: '/img.jpg', alt: 'test' },
      },
    };
    const result = collectDeepPaths(data);
    expect(result).toContainEqual(['seo']);
    expect(result).toContainEqual(['seo', 'image']);
  });

  // ── buildDeepPopulateParams line-level coverage ───────────────────────────

  test('buildDeepPopulateParams: uses rawQuery as base params (line 274)', () => {
    const params = buildDeepPopulateParams([['layout'], ['layout', 'columns']], {
      rawQuery: 'locale=fr&filters[slug][$eq]=/home/',
    });
    const str = decodeURIComponent(params.toString());
    expect(str).toContain('locale=fr');
    expect(str).toContain('filters[slug][$eq]=/home/');
    expect(str).toContain('populate[layout][populate][columns][populate]');
  });

  test('buildDeepPopulateParams: builds filters and locale without rawQuery (lines 276-281)', () => {
    const params = buildDeepPopulateParams([['layout']], {
      filters: { slug: '/home/' },
      locale: 'en',
    });
    const str = decodeURIComponent(params.toString());
    expect(str).toContain('filters[slug][$eq]=/home/');
    expect(str).toContain('locale=en');
    expect(str).toContain('populate[layout][populate]');
  });

  test('buildDeepPopulateParams: sets basePopulateKey (line 282)', () => {
    const params = buildDeepPopulateParams([], {
      basePopulateKey: 'populate[components][on][x][populate]',
      basePopulateValue: '*',
    });
    expect(params.get('populate[components][on][x][populate]')).toBe('*');
  });

  test('buildDeepPopulateParams: appends extraEntries (lines 292-294)', () => {
    const params = buildDeepPopulateParams([['layout']], {
      extraEntries: [['some[extra][key]', 'val']],
    });
    expect(params.get('some[extra][key]')).toBe('val');
  });
});
