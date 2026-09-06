const fs = require('node:fs');
const path = require('node:path');
const { normalizePagePath } = require('next/dist/shared/lib/page-path/normalize-page-path');
const {
  FRAMEWORK_FILES, discoverPageRoutes, reconcilePageRoutes,
  getConfiguredPageExtensions, validatePageExtensions,
} = require('../src/testSupport/pageRouteInventory.js');
const inventory = require('../src/testSupport/authRouteInventory.json');

/** Identify JSON object maps; arrays and primitives cannot represent route maps. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Assert built Pages Router artifacts match independently discovered sources.
 * Accepts parsed artifacts for negative tests; returns only route/count metadata.
 * Static HTML, ISR, missing/non-matching/overbroad SSR data routes, and unknown routes fail closed.
 * Validates nextBuildId before using it to match SSR data routes.
 * @param {object} input - Inventory, discovery, manifests, and nextBuildId.
 * @returns {object} Safe qualification summary.
 */
function checkProtectedPageArtifacts({ entries, discovered, pages, prerender, routes, nextBuildId }) {
  // Next compares one decoded request segment to the build ID; URL parsing must preserve it.
  if (typeof nextBuildId !== 'string' || !nextBuildId || /[/\\%?#\s]/.test(nextBuildId)
      || new URL(`/_next/data/${nextBuildId}/`, 'http://localhost').pathname !== `/_next/data/${nextBuildId}/`) {
    throw new Error('Missing or invalid Next build ID.');
  }
  reconcilePageRoutes(discovered, entries);
  if (!isRecord(pages) || !isRecord(prerender?.routes)
      || !isRecord(prerender?.dynamicRoutes) || !Array.isArray(routes?.dataRoutes)
      || routes.dataRoutes.some((entry) => !isRecord(entry) || typeof entry.page !== 'string')) {
    throw new Error('Missing or malformed protected-page build manifests.');
  }
  const expected = new Map(entries.map((entry) => [entry.route, entry]));
  for (const route of Object.keys(pages)) {
    if (!expected.has(route) && !FRAMEWORK_FILES.has(route)) {
      throw new Error(`Unclassified built route: ${route}`);
    }
  }
  for (const entry of entries) {
    if (typeof pages[entry.route] !== 'string') throw new Error(`Missing built route: ${entry.route}`);
  }
  const protectedRoutes = entries.filter((entry) => entry.policy === 'protected-page');
  for (const { route } of protectedRoutes) {
    if (!/\.js$/.test(pages[route])) throw new Error(`Protected route is not a server module: ${route}`);
    if (Object.hasOwn(prerender.routes, route) || Object.hasOwn(prerender.dynamicRoutes, route)) {
      throw new Error(`Protected route is prerendered: ${route}`);
    }
    const dataRoutes = routes.dataRoutes.filter((entry) => entry.page === route);
    if (dataRoutes.length !== 1 || typeof dataRoutes[0].dataRouteRegex !== 'string'
        || !dataRoutes[0].dataRouteRegex.startsWith('^') || !dataRoutes[0].dataRouteRegex.endsWith('$')) {
      throw new Error(`Missing or ambiguous SSR data route: ${route}`);
    }
    let dataRouteRegex;
    try { dataRouteRegex = new RegExp(dataRoutes[0].dataRouteRegex); } catch {
      throw new Error(`Malformed SSR data route: ${route}`);
    }
    // Resolve the index path and dynamic parameters into a concrete Pages Router data URL.
    const pageSegments = normalizePagePath(route).split('/');
    const pagePath = pageSegments.join('/').replace(/\[[^/]+\]/g, 'sample');
    const expectedDataUrl = path.posix.join('/_next/data', nextBuildId, `${pagePath}.json`);
    if (!dataRouteRegex.test(expectedDataUrl)) {
      throw new Error(`Non-matching SSR data route: ${route}`);
    }
    // Change a literal segment; changing a dynamic parameter would still be on-route.
    const offRouteSegments = pagePath.split('/');
    for (let index = pageSegments.length - 1; index > 0; index -= 1) {
      if (!pageSegments[index].includes('[')) {
        offRouteSegments[index] += '-unrelated';
        break;
      }
    }
    const offRoutePath = offRouteSegments.join('/');
    // Fully dynamic catch-alls may accept any page path, but never a different data prefix.
    const offRouteUrl = offRoutePath === pagePath
      ? path.posix.join('/_next/unrelated', nextBuildId, `${pagePath}.json`)
      : path.posix.join('/_next/data', nextBuildId, `${offRoutePath}.json`);
    if (dataRouteRegex.test(`/_next/data/${nextBuildId}-incorrect${pagePath}.json`)
        || dataRouteRegex.test(offRouteUrl)
        || dataRouteRegex.test(path.posix.join('/_next/data', nextBuildId, `${pagePath}xjson`))
        // Extra path depth is off-route only when the page has no catch-all parameter.
        || (!route.includes('[...') && dataRouteRegex.test(`${expectedDataUrl}/unrelated.json`))) {
      throw new Error(`Overbroad SSR data route: ${route}`);
    }
  }
  return { protectedRoutes: protectedRoutes.map((entry) => entry.route), count: protectedRoutes.length };
}

/** Read one build manifest without printing its potentially sensitive contents. */
function readManifest(root, relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
  } catch {
    throw new Error(`Missing or malformed build manifest: ${relativePath}`);
  }
}

/**
 * Check this checkout's .next output and production-resolved extension snapshot.
 * Required-server-files is inspected only for pageExtensions; config/env is never
 * returned or logged. This verifies local artifacts, not Vercel CDN behavior.
 * @param {string} root - Clean, locked-install repository root.
 * @returns {object} Safe route count and actual Next build identifier.
 */
function checkProtectedPageBuild(root = process.cwd()) {
  const configuredExtensions = getConfiguredPageExtensions(root);
  const builtConfig = readManifest(root, '.next/required-server-files.json');
  const extensions = validatePageExtensions(builtConfig?.config?.pageExtensions);
  if (JSON.stringify(extensions) !== JSON.stringify(configuredExtensions)) {
    throw new Error('Source and production-build pageExtensions differ.');
  }
  const nextBuildId = fs.readFileSync(path.join(root, '.next/BUILD_ID'), 'utf8').trim();
  if (typeof nextBuildId !== 'string') throw new Error('Missing or invalid Next build ID.');
  const summary = checkProtectedPageArtifacts({
    nextBuildId,
    entries: inventory,
    discovered: discoverPageRoutes(path.join(root, 'src/pages'), extensions),
    pages: readManifest(root, '.next/server/pages-manifest.json'),
    prerender: readManifest(root, '.next/prerender-manifest.json'),
    routes: readManifest(root, '.next/routes-manifest.json'),
  });
  return { ...summary, nextBuildId };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(checkProtectedPageBuild())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { checkProtectedPageArtifacts, checkProtectedPageBuild };
