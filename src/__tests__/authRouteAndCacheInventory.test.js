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
const PROTECTED_PAGES = [
  'admin/index.js',
  'admin/users.js',
  'admin/users/[id].js',
  'billing/cancel.js',
  'billing/index.js',
  'billing/success.js',
  'index.js',
];
const PUBLIC_PAGES = [
  '403.js',
  '404.js',
  '429.js',
  '500.js',
  '502.js',
  '503.js',
  '504.js',
  'auth/callback.js',
  'login.js',
];
const PROTECTED_APIS = [
  'api/[id].js',
  'api/admin/users/[id].js',
  'api/admin/users/[id]/role.js',
  'api/admin/users/index.js',
  'api/auth/csrf.js',
  'api/billing/checkout-status.js',
  'api/billing/checkout.js',
  'api/billing/portal.js',
  'api/billing/status.js',
  'api/index.js',
  'api/storage/export.js',
  'api/storage/locked-jobs.js',
  'api/storage/status.js',
];
const PUBLIC_COOKIE_APIS = [
  'api/auth/session.js',
  'api/auth/signout.js',
];
const PUBLIC_NON_COOKIE_APIS = [
  'api/billing/webhook.js',
  'api/health.js',
];
const ROUTE_OWNED_PRIVATE_CACHE_APIS = [
  'api/billing/status.js',
  'api/storage/export.js',
  'api/storage/locked-jobs.js',
  'api/storage/status.js',
];

/**
 * Recursively lists JavaScript files relative to the pages directory.
 *
 * Purpose: route inventories must detect newly added nested pages and APIs on
 * every platform while keeping comparisons stable with forward slashes.
 *
 * @param {string} directory - Absolute directory currently being inspected.
 * @returns {string[]} Sorted page-root-relative JavaScript paths.
 */
function listPageJavascriptFiles(directory = PAGES_ROOT) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listPageJavascriptFiles(absolutePath);
    }
    if (!entry.isFile() || path.extname(entry.name) !== '.js') {
      return [];
    }
    return [path.relative(PAGES_ROOT, absolutePath).replaceAll('\\', '/')];
  }).sort();
}

/**
 * Reads one routable source file from the page-root inventory.
 *
 * @param {string} relativePath - Forward-slash path relative to src/pages.
 * @returns {string} UTF-8 route source.
 */
function readPageSource(relativePath) {
  return fs.readFileSync(path.join(PAGES_ROOT, ...relativePath.split('/')), 'utf8');
}

describe('auth route and cache inventory', () => {
  it('requires every routable page and API to have an explicit policy', () => {
    const actualRoutes = listPageJavascriptFiles().filter((relativePath) => (
      !path.basename(relativePath).startsWith('_')
    ));
    const expectedRoutes = [
      ...PROTECTED_PAGES,
      ...PUBLIC_PAGES,
      ...PROTECTED_APIS,
      ...PUBLIC_COOKIE_APIS,
      ...PUBLIC_NON_COOKIE_APIS,
    ].sort();

    expect(actualRoutes).toEqual(expectedRoutes);
  });

  it('keeps inventoried pages aligned with middleware classification', () => {
    const protectedPaths = [
      '/',
      '/admin',
      '/admin/users',
      '/admin/users/example-id',
      '/billing',
      '/billing/cancel',
      '/billing/success',
    ];
    const publicPaths = [
      '/login',
      '/auth/callback',
      '/403',
      '/404',
      '/429',
      '/500',
      '/502',
      '/503',
      '/504',
    ];

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
