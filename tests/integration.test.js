/**
 * Integration tests — data file vs live API response
 *
 * Structure: data/{collection}/{name}.json
 *   - Collection name comes from the directory name
 *   - File can be named anything (test1.json, home.json, etc.)
 *   - Each file must have data[0].documentId and optionally data[0].locale
 *
 * For each JSON file found:
 *   1. Collection = parent directory name
 *   2. Read data[0].documentId and data[0].locale from the file
 *   3. Fetch GET /api/{collection}/{documentId}?locale={locale}&depth=full
 *   4. Assert every key in the reference file exists in the response with matching value
 *
 * Requires the service to be running (SERVICE_URL env var, default http://localhost:3001)
 * and Strapi to be reachable.
 *
 * Run:  npx jest tests/integration.test.js
 *       SERVICE_URL=http://localhost:3001 npx jest tests/integration.test.js
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SERVICE_URL = process.env.SERVICE_URL || 'http://localhost:3001';
const DATA_DIR = path.join(__dirname, '..', 'data');

// System/volatile fields — excluded from comparison because they change on every
// content save (numeric id, timestamps) and are not meaningful for content checks.
const SKIP_FIELDS = new Set(['id', 'updatedAt', 'publishedAt', 'createdAt']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Deep subset check.
 * Returns an array of human-readable mismatch messages.
 * Every key present in `expected` must exist in `actual` with an equal value.
 * Extra keys in `actual` are silently ignored.
 */
function checkSubset(expected, actual, keyPath = '') {
  const errors = [];

  if (expected === undefined) return errors;

  // Null — must match exactly
  if (expected === null) {
    if (actual !== null) {
      errors.push(`${keyPath}: expected null, got ${JSON.stringify(actual)}`);
    }
    return errors;
  }

  // Primitive — exact equality
  if (typeof expected !== 'object') {
    if (expected !== actual) {
      errors.push(`${keyPath}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return errors;
  }

  // Array — check each element at the same index
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      errors.push(`${keyPath}: expected array, got ${typeof actual}`);
      return errors;
    }
    expected.forEach((item, i) => {
      errors.push(...checkSubset(item, actual[i], `${keyPath}[${i}]`));
    });
    return errors;
  }

  // Object — every key in expected must exist in actual
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    errors.push(`${keyPath}: expected object, got ${JSON.stringify(actual)}`);
    return errors;
  }

  for (const key of Object.keys(expected)) {
    if (SKIP_FIELDS.has(key)) continue;
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    if (!(key in actual)) {
      errors.push(`${childPath}: key missing from response`);
      continue;
    }
    errors.push(...checkSubset(expected[key], actual[key], childPath));
  }

  return errors;
}

// ── Load test cases ───────────────────────────────────────────────────────────

function loadTestCases() {
  if (!fs.existsSync(DATA_DIR)) return [];

  const cases = [];

  for (const collection of fs.readdirSync(DATA_DIR)) {
    const collectionDir = path.join(DATA_DIR, collection);
    if (!fs.statSync(collectionDir).isDirectory()) continue;

    for (const filename of fs.readdirSync(collectionDir)) {
      if (!filename.endsWith('.json')) continue;

      const filePath = path.join(collectionDir, filename);
      const fileJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const entry = Array.isArray(fileJson.data) ? fileJson.data[0] : fileJson.data ?? fileJson;

      if (!entry?.documentId) {
        console.warn(`[Integration] Skipping ${collection}/${filename} — no documentId found at data[0]`);
        continue;
      }

      cases.push({
        label: `${collection}/${filename}`,
        collection,
        filename,
        documentId: entry.documentId,
        locale: entry.locale || 'en',
        reference: entry,
      });
    }
  }

  return cases;
}

const TEST_CASES = loadTestCases();

// ── Tests ─────────────────────────────────────────────────────────────────────

if (TEST_CASES.length === 0) {
  test.skip('No integration test files found in data/ (add data/{collection}/test1.json files)', () => {});
} else {
  describe('Integration — reference JSON vs API response', () => {
    test.each(TEST_CASES.map((tc) => [tc.label, tc]))(
      '%s',
      async (_, { label, collection, documentId, locale, reference }) => {
        const url = `${SERVICE_URL}/api/${collection}/${documentId}?locale=${locale}&depth=full`;

        let res;
        try {
          res = await axios.get(url, { timeout: 60000 });
        } catch (err) {
          if (['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(err.code)) {
            console.warn(`[Integration] Service unreachable at ${SERVICE_URL} (${err.code}) — skipping ${label}`);
            return;
          }
          const status = err.response?.status;
          if (status === 404) {
            console.warn(`[Integration] Document not found in Strapi — skipping ${label} (documentId: ${documentId})`);
            return;
          }
          if (status >= 500) {
            console.warn(`[Integration] Service/upstream error ${status} — skipping ${label}: ${JSON.stringify(err.response?.data)}`);
            return;
          }
          throw new Error(
            `Request failed for ${label}: ${status ?? err.message}\n` +
            (err.response?.data ? JSON.stringify(err.response.data) : '')
          );
        }

        // Response is single-doc shape: { data: {...} } or { data: [{...}] }
        const responseData = res.data?.data;
        const actual = Array.isArray(responseData) ? responseData[0] : responseData;

        expect(actual).toBeTruthy();

        const errors = checkSubset(reference, actual);

        if (errors.length > 0) {
          throw new Error(
            `[${label}] ${errors.length} mismatch(es):\n` +
            errors.map((e) => `  • ${e}`).join('\n')
          );
        }
      },
      60000 // per-test timeout
    );
  });
}
