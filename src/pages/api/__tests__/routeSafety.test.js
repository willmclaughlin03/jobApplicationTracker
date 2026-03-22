/**
 * Safety net test: Ensures all API route files use withRateLimit wrapper
 *
 * Purpose: Prevent new routes from being added without rate limiting and
 * centralized auth. If this test fails, a developer has added a route
 * that bypasses the withRateLimit middleware.
 *
 * Connects to: All files in src/pages/api/ (excluding __tests__/)
 *
 * How it works:
 * - Recursively scans src/pages/api/ for .js route files
 * - Reads each file's source code
 * - Asserts that each file contains "export default withRateLimit("
 * - Fails CI with a clear message listing unwrapped routes
 */

const fs = require('fs');
const path = require('path');

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
  /**
   * Test: All route files must use withRateLimit
   *
   * Scans every .js file in src/pages/api/ (excluding __tests__/) and
   * verifies it contains "export default withRateLimit(" in its source.
   * This catches any new route that was added without the middleware wrapper.
   *
   * If this test fails, wrap your new route handler with:
   *   export default withRateLimit(handler, { requireAuth: true })
   *
   * For public routes (no auth required), use:
   *   export default withRateLimit(handler, { requireAuth: false, operation: OPERATIONS.AUTH })
   */
  it('all API routes should be wrapped with withRateLimit', () => {
    const apiDir = path.resolve(__dirname, '..');
    const routeFiles = getRouteFiles(apiDir);

    // Sanity check: we should find at least the known route files
    expect(routeFiles.length).toBeGreaterThan(0);

    const unwrappedRoutes = [];

    for (const filePath of routeFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(path.resolve(__dirname, '../../..'), filePath);

      if (!content.includes('export default withRateLimit(')) {
        unwrappedRoutes.push(relativePath);
      }
    }

    if (unwrappedRoutes.length > 0) {
      throw new Error(
        `The following API routes are NOT wrapped with withRateLimit:\n` +
        unwrappedRoutes.map((r) => `  - ${r}`).join('\n') +
        `\n\nAll routes must use: export default withRateLimit(handler, { ... })\n` +
        `See src/server/middleware/withRateLimit.js for usage.`
      );
    }
  });
});
