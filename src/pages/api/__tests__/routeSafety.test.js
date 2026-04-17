/**
 * Safety net test: Ensures all API route files use approved wrapper entrypoints
 *
 * Purpose: Prevent new routes from being added without one of the approved
 * centralized wrappers. If this test fails, a developer has added a route
 * that bypasses the supported middleware entrypoints.
 *
 * Connects to: All files in src/pages/api/ (excluding __tests__/)
 *
 * How it works:
 * - Recursively scans src/pages/api/ for .js route files
 * - Reads each file's source code
 * - Asserts that each file contains an approved wrapper export
 * - Fails CI with a clear message listing unwrapped routes
 */

const fs = require('fs');
const path = require('path');

// Routes that intentionally skip withRateLimit — currently none.
// health.js was moved behind withRateLimit with OPERATIONS.HEALTH (60 req/hour per IP).
const EXCLUDED_ROUTES = [];

/**
 * Recursively collects all .js route files from a directory
 * Excludes __tests__ directories
 *
 * Assumption: All API routes in this project are .js files.
 * If .ts/.tsx routes are added in the future, extend the
 * endsWith check below to include those extensions.
 *
 * @param {string} dir - Directory to scan
 * @returns {string[]} Array of absolute file paths
 */
function getRouteFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    if (EXCLUDED_ROUTES.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...getRouteFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('API Route Safety', () => {
  const APPROVED_WRAPPER_EXPORTS = [
    'export default withRateLimit(',
    'export default withWebhookAuth(',
  ];

  /**
   * Test: All route files must use one of the approved wrappers
   *
   * Scans every .js file in src/pages/api/ (excluding __tests__/) and
   * verifies it contains one of the approved wrapper exports in its source.
   * This catches any new route that was added without the middleware wrapper.
   *
   * If this test fails, wrap your new route handler with one of:
   *   export default withRateLimit(handler, { requireAuth: true })
   *   export default withWebhookAuth(handler, { allowedMethods: ['POST'] })
   *
   * For public routes (no auth required), use:
   *   export default withRateLimit(handler, { requireAuth: false, operation: OPERATIONS.AUTH })
   */
  it('all API routes should be wrapped with an approved middleware wrapper', () => {
    const apiDir = path.resolve(__dirname, '..');
    const routeFiles = getRouteFiles(apiDir);

    // Sanity check: we should find at least the known route files
    expect(routeFiles.length).toBeGreaterThan(0);

    const unwrappedRoutes = [];

    for (const filePath of routeFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(path.resolve(__dirname, '../../..'), filePath);

      const hasApprovedWrapper = APPROVED_WRAPPER_EXPORTS.some((wrapperExport) =>
        content.includes(wrapperExport)
      );

      if (!hasApprovedWrapper) {
        unwrappedRoutes.push(relativePath);
      }
    }

    if (unwrappedRoutes.length > 0) {
      throw new Error(
        `The following API routes are NOT wrapped with an approved middleware wrapper:\n` +
        unwrappedRoutes.map((r) => `  - ${r}`).join('\n') +
        `\n\nAll routes must use exactly one approved wrapper export:\n` +
        APPROVED_WRAPPER_EXPORTS.map((wrapperExport) => `  - ${wrapperExport}...`).join('\n') +
        `\nSee src/server/middleware/withRateLimit.js and src/server/middleware/withWebhookAuth.js for usage.`
      );
    }
  });
});
