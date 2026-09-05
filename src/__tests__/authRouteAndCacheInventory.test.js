/**
 * Authentication route and cache-policy inventory.
 *
 * Purpose: fail closed when a routable page or API is added without being
 * assigned to the protected, public-cookie, or public-non-cookie contract.
 */

const fs = require('fs');
const path = require('path');

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    next: jest.fn(),
    redirect: jest.fn(),
  },
}));

const {
  ROUTE_POLICY,
  classifyRoutePolicy,
} = require('../middleware.js');

const PAGES_ROOT = path.join(process.cwd(), 'src', 'pages');
const inventory = require('../testSupport/authRouteInventory.json');
const {
  getConfiguredPageExtensions,
  discoverPageRoutes,
  reconcilePageRoutes,
  pageFileToRoute,
} = require('../testSupport/pageRouteInventory.js');
const extensions = getConfiguredPageExtensions(process.cwd());
const PROTECTED_PAGES = inventory.filter((entry) => entry.policy === 'protected-page').map((entry) => entry.file);
const PUBLIC_PAGES = inventory.filter((entry) => entry.policy === 'public-page').map((entry) => entry.file);
const PROTECTED_APIS = inventory.filter((entry) => entry.policy === 'protected-api').map((entry) => entry.file);
const PUBLIC_COOKIE_APIS = inventory.filter((entry) => entry.policy === 'public-cookie-api').map((entry) => entry.file);

const ROUTE_OWNED_PRIVATE_CACHE_APIS = [
  'api/billing/status.js',
  'api/storage/export.js',
  'api/storage/locked-jobs.js',
  'api/storage/status.js',
];

/**
 * Reads one routable source file from the page-root inventory.
 *
 * @param {string} relativePath - Forward-slash path relative to src/pages.
 * @returns {string} UTF-8 route source.
 */
function readPageSource(relativePath) {
  return fs.readFileSync(path.join(PAGES_ROOT, ...relativePath.split('/')), 'utf8');
}

/**
 * Converts an inventoried Pages Router file into a representative pathname.
 *
 * Purpose: keep middleware policy assertions derived from the authoritative
 * page inventories, including index routes and concrete dynamic-route samples.
 *
 * @param {string} relativePath - Forward-slash path relative to src/pages.
 * @returns {string} Representative URL pathname for the page file.
 */
function getRepresentativePagePath(relativePath) {
  return pageFileToRoute(relativePath, extensions).replace(/\[[^/]+\]/g, 'example-id');
}

describe('auth route and cache inventory', () => {
  it('requires every routable page and API to have an explicit policy', () => {
    const actualRoutes = discoverPageRoutes(PAGES_ROOT, extensions);
    expect(() => reconcilePageRoutes(actualRoutes, inventory)).not.toThrow();
  });

  it('keeps inventoried pages aligned with middleware classification', () => {
    const protectedPaths = PROTECTED_PAGES.map(getRepresentativePagePath);
    const publicPaths = PUBLIC_PAGES.map(getRepresentativePagePath);

    protectedPaths.forEach((pathname) => {
      expect(classifyRoutePolicy(pathname)).toBe(ROUTE_POLICY.PROTECTED);
    });
    publicPaths.forEach((pathname) => {
      expect(classifyRoutePolicy(pathname)).toBe(ROUTE_POLICY.PUBLIC);
    });
    expect(classifyRoutePolicy('/route-that-does-not-exist')).toBe(
      ROUTE_POLICY.UNMATCHED
    );
  });

  it('keeps protected APIs on the shared wrapper without public cache overrides', () => {
    PROTECTED_APIS.forEach((relativePath) => {
      const source = readPageSource(relativePath);
      expect(source).toContain('withRateLimit');
      expect(source).toMatch(/requireAuth:\s*true/);
      expect(source).not.toMatch(/Cache-Control['"]\s*,\s*['"]public/i);
      expect(source).not.toMatch(/cacheControl:\s*['"]public/i);
    });

    const wrapperSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'server', 'middleware', 'withRateLimit.js'),
      'utf8'
    );
    expect(wrapperSource).toContain(
      'const effectiveCacheControl = requireAuth ? PRIVATE_NO_STORE : cacheControl;'
    );
    expect(wrapperSource.indexOf("res.setHeader('Cache-Control', effectiveCacheControl)")).toBeLessThan(
      wrapperSource.indexOf('attachRequestLogger(req)')
    );
  });

  it('requires every public cookie-capable API to opt into private no-store', () => {
    PUBLIC_COOKIE_APIS.forEach((relativePath) => {
      const source = readPageSource(relativePath);
      expect(source).toMatch(/requireAuth:\s*false/);
      expect(source).toMatch(/cacheControl:\s*(?:PRIVATE_NO_STORE|['"]private, no-store['"])/);
    });
  });

  it('keeps health and webhook outside the auth-cookie cache contract', () => {
    const healthSource = readPageSource('api/health.js');
    const webhookSource = readPageSource('api/billing/webhook.js');

    expect(healthSource).toMatch(/requireAuth:\s*false/);
    expect(healthSource).not.toContain('cacheControl');
    expect(healthSource).not.toContain('createApiRouteClient');
    expect(webhookSource).toContain('withWebhookAuth');
    expect(webhookSource).not.toContain('withRateLimit');
    expect(webhookSource).not.toContain('Cache-Control');
  });

  it('keeps exact route-owned private and CDN no-store headers', () => {
    ROUTE_OWNED_PRIVATE_CACHE_APIS.forEach((relativePath) => {
      const source = readPageSource(relativePath);
      expect(source).toContain("res.setHeader('Cache-Control', 'private, no-store')");
      expect(source).toContain("res.setHeader('CDN-Cache-Control', 'no-store')");
      expect(source).toContain("res.setHeader('Pragma', 'no-cache')");
      expect(source).toContain("res.setHeader('Vary', 'Cookie')");
    });
  });
});
