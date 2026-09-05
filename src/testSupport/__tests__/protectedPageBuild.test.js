const { checkProtectedPageArtifacts } = require('../../../scripts/check-protected-page-build.js');

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
      { page: '/', dataRouteRegex: '^/_next/data/build/index.json$' },
      { page: '/admin/users/[id]', dataRouteRegex: '^/_next/data/build/admin/users/[^/]+.json$' },
    ] },
  };
}

describe('protected-page production artifacts', () => {
  /** Match both protected routes to each valid ID to preserve the accepted format. */
  it.each(['build', 'Build_123-abc'])('accepts request-time artifacts for build ID %s', (nextBuildId) => {
    const input = fixture();
    input.nextBuildId = nextBuildId;
    for (const dataRoute of input.routes.dataRoutes) {
      dataRoute.dataRouteRegex = dataRoute.dataRouteRegex.replace('build', nextBuildId);
    }
    expect(checkProtectedPageArtifacts(input).count).toBe(2);
  });
  /** Omitted IDs must fail at the artifact boundary with the established diagnostic. */
  it('rejects a missing build ID', () => {
    const input = fixture();
    delete input.nextBuildId;
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Missing or invalid Next build ID.');
  });
  /** Permissive routes must not let malformed IDs bypass boundary validation. */
  it.each([undefined, null, '', ' ', 'build/id', 'build.id', 'build?query', 123, true, {}])(
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
  it('rejects data routes for a different build ID', () => {
    const input = fixture();
    input.nextBuildId = 'different-build';
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Non-matching SSR data route: /');
  });
  it('rejects a regex matching only the literal dynamic route', () => {
    const input = fixture();
    input.routes.dataRoutes[1].dataRouteRegex = '^/_next/data/build/admin/users/\\[id\\]\\.json$';
    expect(() => checkProtectedPageArtifacts(input)).toThrow('SSR data route');
  });
  it.each(['/', '/admin/users/[id]'])('rejects static HTML even with an empty prerender manifest: %s', (route) => {
    const input = fixture();
    input.pages[route] = 'pages/static.html';
    expect(() => checkProtectedPageArtifacts(input)).toThrow('not a server module');
  });
  it.each(['routes', 'dynamicRoutes'])('rejects protected prerender entries in %s', (kind) => {
    const input = fixture();
    input.prerender[kind]['/'] = {};
    expect(() => checkProtectedPageArtifacts(input)).toThrow('prerendered');
  });
  it('reconciles newly discovered JSX before trusting the explicit list', () => {
    const input = fixture();
    input.discovered.push({ file: 'billing/history.jsx', route: '/billing/history' });
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Unclassified');
  });
  it('rejects unknown built routes, including underscore-prefixed routes', () => {
    const input = fixture();
    input.pages['/_hidden'] = 'pages/_hidden.html';
    expect(() => checkProtectedPageArtifacts(input)).toThrow('Unclassified built route');
  });
  it('rejects missing modules and data routes', () => {
    const missingPage = fixture();
    delete missingPage.pages['/'];
    expect(() => checkProtectedPageArtifacts(missingPage)).toThrow('Missing built route');
    const missingData = fixture();
    missingData.routes.dataRoutes = [];
    expect(() => checkProtectedPageArtifacts(missingData)).toThrow('SSR data route');
  });
  it.each(['pages', 'prerender', 'routes'])('rejects a missing %s manifest', (key) => {
    const input = fixture();
    delete input[key];
    expect(() => checkProtectedPageArtifacts(input)).toThrow('manifests');
  });

  it.each(['not-a-map', [], null])('rejects malformed prerender route maps: %j', (value) => {
    const input = fixture();
    input.prerender.routes = value;
    expect(() => checkProtectedPageArtifacts(input)).toThrow('manifests');
  });

  it.each(['', '^[$', '^$', '^/_next/data/build/unrelated\\.json$'])('rejects invalid data regex: %s', (regex) => {
    for (const routeIndex of [0, 1]) {
      const input = fixture();
      input.routes.dataRoutes[routeIndex].dataRouteRegex = regex;
      expect(() => checkProtectedPageArtifacts(input)).toThrow('SSR data route');
    }
  });
});
