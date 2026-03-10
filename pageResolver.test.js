/**
 * Tests use the actual data shape from data-202639182528.json
 * to verify the resolver works correctly without hitting real Strapi.
 */

const PageResolver = require('../src/pageResolver');

// ── Mock data matching your exact Strapi response shape ───────────────────────

const MOCK_PAGE_SHELL = {
  id: 30,
  documentId: 'h2ys4qx77kebctut8u4ai5iy',
  page_name: 'Dynamic Bla Bla',
  slug: '/dynamic/{{dynamic}}/',
  locale: 'en',
  platform: 'web',
  site_code: 'adv',
  background_color: 'ghost_white',
  layout: [
    {
      id: 28,
      row_title: 'row',
      container_type: 'container-normal',
      columns: [
        {
          id: 28,
          column_title: 'col',
          desktop_grid_size: 'full-width',
          component_instance: {
            id: 40,
            documentId: 'kgrda2v2o52q6qzeus8hu3l7',
            component_title: 'Navigation',
          },
        },
      ],
    },
    {
      id: 29,
      row_title: 'row',
      container_type: 'container-normal',
      columns: [
        {
          id: 29,
          column_title: 'col',
          desktop_grid_size: 'full-width',
          component_instance: {
            id: 146,
            documentId: 'xwwazo19pcqdyadk330wq49y',
            component_title: 'Flexible Component Wrapper',
          },
        },
      ],
    },
  ],
  component_replacement: [],
  seo_elements: null,
  auth: [],
};

// Level-1: Navigation (leaf component)
const MOCK_CI_NAVIGATION = {
  id: 40,
  documentId: 'kgrda2v2o52q6qzeus8hu3l7',
  component_title: 'Navigation',
  locale: 'en',
  components: [
    {
      __component: 'components.navigation',
      id: 16,
      nav_links: [{ id: 653, text: 'Funds', url: '/funds/' }],
    },
  ],
};

// Level-1: Wrapper component (contains inner layout with level-2 CIs)
const MOCK_CI_WRAPPER = {
  id: 146,
  documentId: 'xwwazo19pcqdyadk330wq49y',
  component_title: 'Flexible Component Wrapper',
  locale: 'en',
  components: [
    {
      __component: 'components.composition-wrapper',
      id: 6,
      variant: 'transparent',
      layout: [
        {
          id: 9,
          row_title: 'row',
          columns: [
            {
              id: 9,
              column_title: 'column',
              component_instance: {
                id: 141,
                documentId: 'ccfvv9kcfp3iziok2unj8cd3',
                component_title: 'Composition Text 1',
              },
            },
          ],
        },
      ],
    },
  ],
};

// Level-2: Inner component (leaf)
const MOCK_CI_INNER = {
  id: 141,
  documentId: 'ccfvv9kcfp3iziok2unj8cd3',
  component_title: 'Composition Text 1',
  locale: 'en',
  components: [
    {
      __component: 'components.quotes',
      id: 3,
      title: 'Quote of the day',
      quote: '"Being rich is having money; being wealthy is having time."',
      writer: '-Margaret Bonanno',
    },
  ],
};

// ── Mock Strapi Client ────────────────────────────────────────────────────────

function createMockStrapiClient() {
  return {
    fetchPageBySlug: jest.fn().mockResolvedValue(MOCK_PAGE_SHELL),
    fetchComponentInstancesBatch: jest.fn().mockImplementation((docIds) => {
      const map = {
        'kgrda2v2o52q6qzeus8hu3l7': MOCK_CI_NAVIGATION,
        'xwwazo19pcqdyadk330wq49y': MOCK_CI_WRAPPER,
        'ccfvv9kcfp3iziok2unj8cd3': MOCK_CI_INNER,
      };
      const result = {};
      for (const id of docIds) result[id] = map[id] || null;
      return Promise.resolve(result);
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PageResolver', () => {
  let mockClient;
  let resolver;

  beforeEach(() => {
    mockClient = createMockStrapiClient();
    resolver = new PageResolver(mockClient);
  });

  test('fetches page shell by slug', async () => {
    await resolver.resolvePage('/dynamic/test/', 'en');
    expect(mockClient.fetchPageBySlug).toHaveBeenCalledWith(
      '/dynamic/test/',
      'en'
    );
  });

  test('collects level-1 component instance documentIds correctly', () => {
    const stubs = resolver._collectInstanceStubs(MOCK_PAGE_SHELL.layout);
    expect(stubs).toHaveLength(2);
    expect(stubs.map((s) => s.documentId)).toContain('kgrda2v2o52q6qzeus8hu3l7');
    expect(stubs.map((s) => s.documentId)).toContain('xwwazo19pcqdyadk330wq49y');
  });

  test('fetches level-1 instances in a single parallel batch', async () => {
    await resolver.resolvePage('/dynamic/test/', 'en');
    // First batch call must include both level-1 documentIds
    const firstCall = mockClient.fetchComponentInstancesBatch.mock.calls[0][0];
    expect(firstCall).toContain('kgrda2v2o52q6qzeus8hu3l7');
    expect(firstCall).toContain('xwwazo19pcqdyadk330wq49y');
  });

  test('detects wrapper and collects inner CI stubs for level-2 batch', () => {
    const level1Map = {
      'xwwazo19pcqdyadk330wq49y': MOCK_CI_WRAPPER,
    };
    const innerStubs = resolver._collectInnerStubs(level1Map);
    expect(innerStubs).toHaveLength(1);
    expect(innerStubs[0].documentId).toBe('ccfvv9kcfp3iziok2unj8cd3');
  });

  test('fetches level-2 instances in a second parallel batch', async () => {
    await resolver.resolvePage('/dynamic/test/', 'en');
    expect(mockClient.fetchComponentInstancesBatch).toHaveBeenCalledTimes(2);
    const secondCall = mockClient.fetchComponentInstancesBatch.mock.calls[1][0];
    expect(secondCall).toContain('ccfvv9kcfp3iziok2unj8cd3');
  });

  test('assembled page preserves original top-level shape', async () => {
    const page = await resolver.resolvePage('/dynamic/test/', 'en');
    expect(page.id).toBe(30);
    expect(page.slug).toBe('/dynamic/{{dynamic}}/');
    expect(page.site_code).toBe('adv');
    expect(page.layout).toHaveLength(2);
  });

  test('leaf component instance is fully resolved in layout', async () => {
    const page = await resolver.resolvePage('/dynamic/test/', 'en');
    const navCI = page.layout[0].columns[0].component_instance;
    expect(navCI.component_title).toBe('Navigation');
    expect(navCI.components[0].__component).toBe('components.navigation');
    expect(navCI.components[0].nav_links[0].text).toBe('Funds');
  });

  test('wrapper component instance has inner layout resolved', async () => {
    const page = await resolver.resolvePage('/dynamic/test/', 'en');
    const wrapperCI = page.layout[1].columns[0].component_instance;
    expect(wrapperCI.component_title).toBe('Flexible Component Wrapper');

    const wrapperComp = wrapperCI.components[0];
    expect(wrapperComp.__component).toBe('components.composition-wrapper');

    const innerCI =
      wrapperComp.layout[0].columns[0].component_instance;
    expect(innerCI.component_title).toBe('Composition Text 1');
    expect(innerCI.components[0].__component).toBe('components.quotes');
    expect(innerCI.components[0].title).toBe('Quote of the day');
  });

  test('handles missing component instance gracefully', async () => {
    mockClient.fetchComponentInstancesBatch.mockResolvedValueOnce({
      'kgrda2v2o52q6qzeus8hu3l7': null, // Simulate fetch failure
      'xwwazo19pcqdyadk330wq49y': MOCK_CI_WRAPPER,
    });

    const page = await resolver.resolvePage('/dynamic/test/', 'en');
    // Should return the stub instead of crashing
    const navCI = page.layout[0].columns[0].component_instance;
    expect(navCI.id).toBe(40); // Original stub preserved
  });

  test('deduplicates inner stubs when same CI appears in multiple wrappers', () => {
    const wrapperWithDuplicates = {
      ...MOCK_CI_WRAPPER,
      components: [
        {
          ...MOCK_CI_WRAPPER.components[0],
          layout: [
            ...MOCK_CI_WRAPPER.components[0].layout,
            {
              id: 99,
              columns: [
                {
                  id: 99,
                  component_instance: {
                    id: 141,
                    documentId: 'ccfvv9kcfp3iziok2unj8cd3', // Same as first col
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const stubs = resolver._collectInnerStubs({
      'xwwazo19pcqdyadk330wq49y': wrapperWithDuplicates,
    });
    // Should be deduped to 1 even though it appears twice
    expect(stubs).toHaveLength(1);
  });
});
