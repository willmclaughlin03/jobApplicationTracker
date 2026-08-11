/**
 * CHUNK-0 inventory tests for auth-capable response and route boundaries.
 *
 * Purpose: Enforce a complete, scenario-owned inventory instead of accepting
 * a header string that may appear only in a comment or unreachable branch.
 * Connects to: the frozen route/cache fixtures and CHUNK-2/4/6 fixes.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  AUTH_CAPABLE_CACHE_INVENTORY,
  AUTH_CONSUMER_STATE_MATRIX,
  ROUTABLE_PAGE_POLICY_FIXTURES,
  ROUTE_CLASSIFICATION_FIXTURES,
} = require('../testSupport/authV2ContractFixtures.js');

/**
 * Recursively lists JavaScript files below one repository directory.
 *
 * @param {string} directory - Absolute directory to inspect.
 * @returns {string[]} Absolute JavaScript file paths.
 */
function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listJavaScriptFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

/**
 * Converts a Pages Router source path into its public route template.
 *
 * @param {string} pageFile - Absolute page-module path.
 * @returns {string|null} Public route or null for framework/API modules.
 */
function pageFileToRoute(pageFile) {
  const pagesRoot = path.join(process.cwd(), 'src', 'pages');
  const relativePath = path.relative(pagesRoot, pageFile).replaceAll('\\', '/');

  if (
    relativePath.startsWith('api/')
    || relativePath === '_app.js'
    || relativePath === '_error.js'
  ) {
    return null;
  }

  const withoutExtension = relativePath.replace(/\.js$/, '');
  const withoutIndex = withoutExtension === 'index'
    ? ''
    : withoutExtension.replace(/\/index$/, '');

  return `/${withoutIndex}`;
}

/**
 * Normalizes one absolute source path to the repository slash format.
 *
 * @param {string} sourcePath - Absolute production source path.
 * @returns {string} Repository-relative slash-separated path.
 */
function toRepositoryPath(sourcePath) {
  return path.relative(process.cwd(), sourcePath).replaceAll('\\', '/');
}

const currentCacheEntries = AUTH_CAPABLE_CACHE_INVENTORY.filter(
  ({ source }) => !source.startsWith('future:')
);

describe('auth-capable cache inventory', () => {
  it.each(currentCacheEntries)(
    'keeps $id source and scenario ownership explicit',
    ({ dependencies, entryPoint, outcomes, owner, source }) => {
      expect(fs.existsSync(path.join(process.cwd(), source))).toBe(true);
      expect(entryPoint).toEqual(expect.any(String));
      expect(outcomes.length).toBeGreaterThan(0);
      expect(owner).toMatch(/^CHUNK-\d+$/);
      expect(dependencies).toEqual(expect.any(Array));
    }
  );

  it('inventories every direct adapter and indirect requireAuth call site', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const discoveredSources = listJavaScriptFiles(sourceRoot)
      .filter((sourcePath) => !sourcePath.includes(`${path.sep}__tests__${path.sep}`))
      .filter((sourcePath) => !sourcePath.includes(`${path.sep}testSupport${path.sep}`))
      .filter((sourcePath) => {
        const source = fs.readFileSync(sourcePath, 'utf8');
        const callsAuthAdapter = /(?:createApiRouteClient|getUserFromRequest)\s*\(/.test(source);
        const usesProtectedWrapper = /withRateLimit\s*\(/.test(source)
          && /requireAuth\s*:\s*true/.test(source);

        return callsAuthAdapter || usesProtectedWrapper;
      })
      .map(toRepositoryPath);
    const inventoriedSources = new Set(currentCacheEntries.map(({ source }) => source));

    expect(discoveredSources.length).toBeGreaterThan(0);
    discoveredSources.forEach((source) => {
      expect(inventoriedSources).toContain(source);
    });
  });

  it('assigns every protected wrapper caller all applicable cache outcomes', () => {
    const protectedApiEntries = currentCacheEntries.filter(({ source }) => {
      if (!source.startsWith('src/pages/api/')) return false;

      const absoluteSource = path.join(process.cwd(), source);
      const contents = fs.readFileSync(absoluteSource, 'utf8');

      return /withRateLimit\s*\(/.test(contents) && /requireAuth\s*:\s*true/.test(contents);
    });
    const expectedProtectedApiEntries = currentCacheEntries.filter(
      ({ outcomes, source }) => source.startsWith('src/pages/api/') && outcomes.includes('auth')
    );

    expect(protectedApiEntries).toHaveLength(expectedProtectedApiEntries.length);
    protectedApiEntries.forEach(({ outcomes }) => {
      expect(outcomes).toEqual(expect.arrayContaining([
        'method',
        'limiter',
        'auth',
        'success',
        'exception',
      ]));
    });
  });
});

describe('auth consumer inventory', () => {
  it('maps every production useAuth consumer to one seven-state policy row', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const discoveredSources = listJavaScriptFiles(sourceRoot)
      .filter((sourcePath) => !sourcePath.includes(`${path.sep}__tests__${path.sep}`))
      .filter((sourcePath) => !sourcePath.includes(`${path.sep}testSupport${path.sep}`))
      .filter((sourcePath) => !sourcePath.endsWith(`${path.sep}contexts${path.sep}AuthContext.js`))
      .filter((sourcePath) => /useAuth\s*\(/.test(fs.readFileSync(sourcePath, 'utf8')))
      .map(toRepositoryPath)
      .sort();
    const inventoriedSources = AUTH_CONSUMER_STATE_MATRIX
      .map(({ source }) => source)
      .sort();

    expect(inventoriedSources).toEqual(discoveredSources);
  });
});

describe('page-route policy inventory', () => {
  it('classifies every routable page exactly once', () => {
    const pagesRoot = path.join(process.cwd(), 'src', 'pages');
    const discoveredRoutes = listJavaScriptFiles(pagesRoot)
      .map(pageFileToRoute)
      .filter(Boolean)
      .sort();
    const classifiedRoutes = Object.values(ROUTABLE_PAGE_POLICY_FIXTURES).flat().sort();

    expect(new Set(classifiedRoutes).size).toBe(classifiedRoutes.length);
    expect(classifiedRoutes).toEqual(discoveredRoutes);
  });

  it('keeps protected, public, and unmatched middleware cases disjoint', () => {
    const allCases = Object.values(ROUTE_CLASSIFICATION_FIXTURES).flat();

    expect(new Set(allCases).size).toBe(allCases.length);
    expect(ROUTE_CLASSIFICATION_FIXTURES.protected).toEqual(expect.arrayContaining([
      '/billing/cancel',
      '/billing/success',
      '/admin/users/[id]',
    ]));
    expect(ROUTE_CLASSIFICATION_FIXTURES.unmatched).toEqual(expect.arrayContaining([
      '/administrator',
      '/billing-example',
      '/%34%30%33',
      '/403%2Fdetails',
    ]));
    expect(ROUTE_CLASSIFICATION_FIXTURES.rawRejected).toEqual(expect.arrayContaining([
      '/403?source=test',
      '/504?source=test',
    ]));
  });
});
