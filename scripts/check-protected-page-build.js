const fs = require('node:fs');
const path = require('node:path');
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
 * Static HTML, ISR, missing SSR data routes, and unknown built routes fail closed.
 * @param {object} input - Inventory, discovery, and sanitized manifest structures.
 * @returns {object} Safe qualification summary.
 */
function checkProtectedPageArtifacts({ entries, discovered, pages, prerender, routes }) {
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
    try { new RegExp(dataRoutes[0].dataRouteRegex); } catch {
      throw new Error(`Malformed SSR data route: ${route}`);
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
  const summary = checkProtectedPageArtifacts({
    entries: inventory,
    discovered: discoverPageRoutes(path.join(root, 'src/pages'), extensions),
    pages: readManifest(root, '.next/server/pages-manifest.json'),
    prerender: readManifest(root, '.next/prerender-manifest.json'),
    routes: readManifest(root, '.next/routes-manifest.json'),
  });
  const nextBuildId = fs.readFileSync(path.join(root, '.next/BUILD_ID'), 'utf8').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(nextBuildId)) throw new Error('Missing or invalid Next build ID.');
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
