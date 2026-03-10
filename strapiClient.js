const axios = require('axios');

class StrapiClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.timeout = config.timeout || 10000;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    // Request logging
    this.http.interceptors.request.use((req) => {
      console.log(`[Strapi] ${req.method?.toUpperCase()} ${req.url}`);
      return req;
    });
  }

  /**
   * Fetch a page by slug with shallow populate (depth 1 only).
   * Returns page shell + layout rows/cols with component_instance stubs.
   */
  async fetchPageBySlug(slug, locale = 'en', populate = 'layout') {
    const params = new URLSearchParams({
      'filters[slug][$eq]': slug,
      'filters[locale][$eq]': locale,
      populate,
    });

    const res = await this.http.get(`/api/pages?${params}`);
    const pages = res.data?.data;

    if (!pages || pages.length === 0) {
      throw new Error(`Page not found for slug: ${slug}`);
    }

    return pages[0];
  }

  /**
   * Fetch a single component instance by documentId with full populate.
   * Uses Strapi's populate=deep or custom deep populate param.
   */
  async fetchComponentInstance(documentId, locale = 'en') {
    const params = new URLSearchParams({
      'filters[locale][$eq]': locale,
      'populate[components][populate]': '*',
    });

    const res = await this.http.get(
      `/api/component-instances/${documentId}?${params}`
    );
    return res.data?.data;
  }

  /**
   * Batch fetch multiple component instances in parallel.
   * Returns a map of documentId -> component instance data.
   */
  async fetchComponentInstancesBatch(documentIds, locale = 'en') {
    if (!documentIds.length) return {};

    const fetches = documentIds.map((docId) =>
      this.fetchComponentInstance(docId, locale)
        .then((data) => ({ docId, data, error: null }))
        .catch((err) => ({ docId, data: null, error: err.message }))
    );

    const results = await Promise.all(fetches);

    const map = {};
    for (const { docId, data, error } of results) {
      if (error) {
        console.warn(`[Strapi] Failed to fetch component ${docId}: ${error}`);
        map[docId] = null;
      } else {
        map[docId] = data;
      }
    }
    return map;
  }
}

module.exports = StrapiClient;
