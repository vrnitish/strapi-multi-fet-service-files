const {
  collectDeepPaths,
  buildFragmentDeepPathEntries,
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
});
