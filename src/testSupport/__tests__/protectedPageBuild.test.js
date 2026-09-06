const fs = require('node:fs');
const path = require('node:path');
const { buildDataRoute } = require('next/dist/server/lib/router-utils/build-data-route');
const { getConfiguredPageExtensions, discoverPageRoutes } = require('../pageRouteInventory.js');
const inventory = require('../authRouteInventory.json');
const {
  checkProtectedPageArtifacts, checkProtectedPageBuild, getExpectedDataUrls,
} = require('../../../scripts/check-protected-page-build.js');

/** Isolate source discovery/configuration so build checks can use in-memory artifacts. */
jest.mock('../pageRouteInventory.js', () => ({
  ...jest.requireActual('../pageRouteInventory.js'),
  getConfiguredPageExtensions: jest.fn(),
  discoverPageRoutes: jest.fn(),
}));

/** Build a minimal independent source/manifest fixture without touching .next. */
function fixture() {
  return {
    nextBuildId: 'build',
    entries: [
      { file: 'index.js', route: '/', policy: 'protected-page' },
      { file: 'admin/users/[id].tsx', route: '/admin/users/[id]', policy: 'protected-page' },
    ],
    discovered: [{ file: 'index.js', route: '/' }, { file: 'admin/users/[id].tsx', route: '/admin/users/[id]' }],
    pages: { '/': 'pages/index.js', '/admin/users/[id]': 'pages/admin/users/[id].js', '/_app': 'pages/_app.js' },
    prerender: { routes: {}, dynamicRoutes: {} },
    routes: { dataRoutes: [
      { page: '/', dataRouteRegex: '^/_next/data/build/index\\.json$' },
      { page: '/admin/users/[id]', dataRouteRegex: '^/_next/data/build/admin/users/[^/]+\\.json$' },
    ] },
  };
}

/** Build one protected route's in-memory artifacts using the installed Next generator. */
function routeFixture(route, nextBuildId = 'build') {
  const input = fixture();
  input.nextBuildId = nextBuildId;
  input.entries = [{ file: 'fixture.js', route, policy: 'protected-page' }];
  input.discovered = [{ file: 'fixture.js', route }];
  input.pages = { [route]: 'pages/server.js' };
  input.routes.dataRoutes = [buildDataRoute(route, nextBuildId)];
  return input;
}

/** Check every generated probe against Next 16.3.3 and require distinct values, depths, and base URLs. */
describe('SSR data URL probes', () => {
  /** Explicit paths prevent an empty or sample-only probe list from satisfying the Next oracle. */
  it.each([
    ['/', ['/index.json']],
    ['/index', ['/index/index.json']],
    ['/index/history', ['/index/index/history.json']],
    ['/index/[id]', ['/index/sample.json', '/index/42.json']],
    ['/admin/users', ['/admin/users.json']],
    ['/admin/users/[id]', [
      '/admin/users/sample.json', '/admin/users/42.json', '/admin/users/item-42_A.json',
      '/admin/users/item.v2.json', '/admin/users/caf%C3%A9.json',
    ]],
    ['/[id]', ['/sample.json', '/42.json']],
    ['/docs/[...slug]', ['/docs/sample.json', '/docs/42.json', '/docs/first/second.json', '/docs/first/second/third.json']],
    ['/[...slug]', ['/sample.json', '/42.json', '/first/second.json', '/first/second/third.json']],
    ['/docs/[[...slug]]', ['/docs/sample.json', '/docs/42.json', '/docs/first/second.json', '/docs/first/second/third.json', '/docs.json']],
    ['/[[...slug]]', ['/sample.json', '/42.json', '/first/second.json', '/first/second/third.json', '.json']],
    ['/teams/[teamId]/users/[id]', ['/teams/42/users/sample.json', '/teams/sample/users/42.json']],
    ['/teams/[id]/docs/[[...slug]]', ['/teams/42/docs/sample.json', '/teams/sample/docs/first/second.json', '/teams/sample/docs.json']],
  ])('matches Next-generated data routes for every probe of %s', (route, requiredPaths) => {
    for (const nextBuildId of ['build', 'v1.2.3+release']) {
      const probes = getExpectedDataUrls(route, nextBuildId);
      const nextRegex = new RegExp(buildDataRoute(route, nextBuildId).dataRouteRegex);
      for (const dataPath of requiredPaths) {
        expect(probes).toContain(`/_next/data/${nextBuildId}${dataPath}`);
      }
      for (const probe of probes) {
        expect(probe).toMatch(nextRegex);
      }
      expect(checkProtectedPageArtifacts(routeFixture(route, nextBuildId))).toEqual({
        protectedRoutes: [route], count: 1,
      });
    }
  });
});

describe('protected-page production artifacts', () => {
  /** Match both protected routes to request-safe IDs, including custom versions and punctuation. */
  it.each(['build', 'Build_123-abc', 'v1.2.3', 'v1.2.3+release'])(
    'accepts request-time artifacts for string build ID %j', (nextBuildId) => {
      const input = fixture();
      input.nextBuildId = nextBuildId;
      const escapedBuildId = nextBuildId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const dataRoute of input.routes.dataRoutes) {
        dataRoute.dataRouteRegex = dataRoute.dataRouteRegex.replace('build', escapedBuildId);
      }
      expect(checkProtectedPageArtifacts(input).count).toBe(2);
    },
  );
  /** Manifest regex generation alone cannot qualify an ID that request matching cannot consume. */
  it('rejects an empty build ID even with Next-generated data routes', () => {
    const input = fixture();
    input.nextBuildId = '';
    input.routes.dataRoutes = [buildDataRoute('/', ''), buildDataRoute('/admin/users/[id]', '')];
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Missing or invalid Next build ID.');
  });
  /** Omitted IDs must fail at the artifact boundary with the established diagnostic. */
  it('rejects a missing build ID', () => {
    const input = fixture();
    delete input.nextBuildId;
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Missing or invalid Next build ID.');
  });
  /** Permissive routes cannot qualify IDs that are missing, split, decoded or changed by URL parsing. */
  it.each([undefined, null, 123, true, {}, [], '', ' ', 'build/id', 'build\\id',
    'build?query', 'build#hash', 'build%2Fid', 'build%invalid', '.', '..', 'build id', 'build\nid', 'b\u00fcild'])(
    'rejects an invalid build ID even when data routes match: %j',
    (nextBuildId) => {
      const input = fixture();
      input.nextBuildId = nextBuildId;
      for (const dataRoute of input.routes.dataRoutes) {
        dataRoute.dataRouteRegex = '^/_next/data/.+\\.json$';
      }
      expect(() => checkProtectedPageArtifacts(input)).toThrow('Missing or invalid Next build ID.');
    },
  );
  /** String IDs still need to match the build's SSR routes after type validation. */
  it.each(['different-build', 'v1.2.3', 'v1.2.3+release'])(
    'rejects data routes for a different build ID: %j', (nextBuildId) => {
      const input = fixture();
      input.nextBuildId = nextBuildId;
      expect(() => checkProtectedPageArtifacts(input)).toThrow('Non-matching SSR data route: /');
    },
  );
  /** Require concrete dynamic URLs; a regex matching literal [id] must fail SSR validation. */
  it('rejects a regex matching only the literal dynamic route', () => {
    const input = fixture();
    input.routes.dataRoutes[1].dataRouteRegex = '^/_next/data/build/admin/users/\\[id\\]\\.json$';
    expect(() => checkProtectedPageArtifacts(input)).toThrow('SSR data route');
  });

  /** Reject sample allowlists, missing catch-all depths/base URLs, and restrictions on either parameter. */
  it.each([
    ['/admin/users/[id]', '^/_next/data/build/admin/users/sample\\.json$'],
    ['/[id]', '^/_next/data/build/sample\\.json$'],
    ['/docs/[...slug]', '^/_next/data/build/docs/sample\\.json$'],
    ['/[...slug]', '^/_next/data/build/sample\\.json$'],
    ['/docs/[[...slug]]', '^/_next/data/build/docs/sample\\.json$'],
    ['/[[...slug]]', '^/_next/data/build/sample\\.json$'],
    ['/docs/[...slug]', '^/_next/data/build/docs/[^/]+\\.json$'],
    ['/[...slug]', '^/_next/data/build/[^/]+\\.json$'],
    ['/docs/[[...slug]]', '^/_next/data/build/docs(?:/[^/]+)?\\.json$'],
    ['/[[...slug]]', '^/_next/data/build(?:/[^/]+)?\\.json$'],
    ['/docs/[...slug]', '^/_next/data/build/docs(?:/[^/]+){1,2}\\.json$'],
    ['/docs/[[...slug]]', '^/_next/data/build/docs/(.+?)\\.json$'],
    ['/[[...slug]]', '^/_next/data/build/(.+?)\\.json$'],
    ['/teams/[teamId]/users/[id]', '^/_next/data/build/teams/sample/users/[^/]+\\.json$'],
    ['/teams/[teamId]/users/[id]', '^/_next/data/build/teams/[^/]+/users/sample\\.json$'],
  ])('rejects a restrictive data regex for %s: %s', (route, regex) => {
    const input = routeFixture(route);
    input.routes.dataRoutes[0].dataRouteRegex = regex;
    expect(() => checkProtectedPageArtifacts(input)).toThrow(`Non-matching SSR data route: ${route}`);
  });
  /** For each protected route, reject HTML output even when prerender metadata is empty. */
  it.each(['/', '/admin/users/[id]'])('rejects static HTML even with an empty prerender manifest: %s', (route) => {
    const input = fixture();
    input.pages[route] = 'pages/static.html';
    expect(() => checkProtectedPageArtifacts(input)).toThrow('not a server module');
  });
  /** Reject protected pages listed in either prerender map to enforce request-time rendering. */
  it.each(['routes', 'dynamicRoutes'])('rejects protected prerender entries in %s', (kind) => {
    const input = fixture();
    input.prerender[kind]['/'] = {};
    expect(() => checkProtectedPageArtifacts(input)).toThrow('prerendered');
  });
  /** Reject an unclassified discovered JSX page before trusting the inventoried build artifacts. */
  it('reconciles newly discovered JSX before trusting the explicit list', () => {
    const input = fixture();
    input.discovered.push({ file: 'billing/history.jsx', route: '/billing/history' });
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Unclassified');
  });
  /** Reject unclassified built routes; an underscore prefix must not bypass inventory checks. */
  it('rejects unknown built routes, including underscore-prefixed routes', () => {
    const input = fixture();
    input.pages['/_hidden'] = 'pages/_hidden.html';
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Unclassified built route');
  });
  /** Remove a protected module or its data routes to verify both omissions fail qualification. */
  it('rejects missing modules and data routes', () => {
    const missingPage = fixture();
    delete missingPage.pages['/'];
    expect(() => checkProtectedPageArtifacts(missingPage)).toThrow('Missing built route');
    const missingData = fixture();
    missingData.routes.dataRoutes = [];
    expect(() => checkProtectedPageArtifacts(missingData)).toThrow('SSR data route');
  });
  /** Omit each required manifest and require the checker to report invalid build manifests. */
  it.each(['pages', 'prerender', 'routes'])('rejects a missing %s manifest', (key) => {
    const input = fixture();
    delete input[key];
    expect(() => checkProtectedPageArtifacts(input)).toThrow('manifests');
  });

  /** Reject strings, arrays and null prerender maps before inspecting protected routes. */
  it.each(['not-a-map', [], null])('rejects malformed prerender route maps: %j', (value) => {
    const input = fixture();
    input.prerender.routes = value;
    expect(() => checkProtectedPageArtifacts(input)).toThrow('manifests');
  });

  /** For both protected routes, reject empty, malformed or non-matching SSR data patterns. */
  it.each(['', '^[$', '^$', '^/_next/data/build/unrelated\\.json$'])('rejects invalid data regex: %s', (regex) => {
    for (const routeIndex of [0, 1]) {
      const input = fixture();
      input.routes.dataRoutes[routeIndex].dataRouteRegex = regex;
      expect(() => checkProtectedPageArtifacts(input)).toThrow('SSR data route');
    }
  });

  /** Positive matches alone must not qualify patterns spanning other builds, routes or suffixes. */
  it.each([
    [0, '^.*$'],
    [1, '^.*$'],
    [0, '^/_next/data/[^/]+/index\\.json$'],
    [1, '^/_next/data/[^/]+/admin/users/[^/]+\\.json$'],
    [0, '^/_next/data/build/.*$'],
    [1, '^/_next/data/build/.*\\.json$'],
    [1, '^/_next/data/build/admin/.*\\.json$'],
    [1, '^/_next/data/build/admin/users/.*\\.json$'],
    [0, '^/_next/data/build/index.json$'],
    [1, '^/_next/data/build/admin/users/[^/]+.json$'],
  ])('rejects an overbroad data regex for route %i: %s', (routeIndex, regex) => {
    const input = fixture();
    input.routes.dataRoutes[routeIndex].dataRouteRegex = regex;
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Overbroad SSR data route');
  });

  /** Next-generated static, dynamic and catch-all routes remain valid with custom IDs. */
  it.each(['/', '/admin/users', '/admin/users/[id]', '/[id]', '/docs/[...slug]', '/[...slug]', '/docs/[[...slug]]', '/[[...slug]]'])(
    'accepts the Next-generated data route for %s', (route) => {
      const input = routeFixture(route, 'v1.2.3+release');
      expect(checkProtectedPageArtifacts(input)).toEqual({ protectedRoutes: [route], count: 1 });
    },
  );
});

/** Exercise the filesystem entry point with a version ID and mocked build artifacts. */
it('accepts a custom version build ID read from BUILD_ID', () => {
  const root = path.resolve('fixture-build');
  const extensions = ['js'];
  const pages = {};
  const dataRoutes = [];
  for (const entry of inventory) {
    pages[entry.route] = 'pages/server.js';
    if (entry.policy === 'protected-page') {
      dataRoutes.push(buildDataRoute(entry.route, 'v1.2.3+release'));
    }
  }
  const files = new Map([
    ['.next/BUILD_ID', 'v1.2.3+release\n'],
    ['.next/required-server-files.json', JSON.stringify({ config: { pageExtensions: extensions } })],
    ['.next/server/pages-manifest.json', JSON.stringify(pages)],
    ['.next/prerender-manifest.json', JSON.stringify({ routes: {}, dynamicRoutes: {} })],
    ['.next/routes-manifest.json', JSON.stringify({ dataRoutes })],
  ]);
  getConfiguredPageExtensions.mockReturnValue(extensions);
  discoverPageRoutes.mockReturnValue(inventory);
  /** Supply only synthetic build files; no real .next artifacts are read or written. */
  const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation((file) => (
    files.get(path.relative(root, file).replaceAll('\\', '/'))
  ));
  try {
    /** Compare the returned protected routes with the synthetic manifest's pages. */
    const protectedRoutes = dataRoutes.map(({ page }) => page);
    expect(checkProtectedPageBuild(root)).toEqual({
      nextBuildId: 'v1.2.3+release',
      count: dataRoutes.length,
      protectedRoutes,
    });
  } finally {
    readFile.mockRestore();
    getConfiguredPageExtensions.mockReset();
    discoverPageRoutes.mockReset();
  }
});
