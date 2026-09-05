const fs = require('node:fs');
const path = require('node:path');

const FRAMEWORK_FILES = new Set(['/_app', '/_document', '/_error']);
const POLICIES = new Set([
  'protected-page', 'public-page', 'protected-api',
  'public-cookie-api', 'public-non-cookie-api',
]);

/**
 * Validate configured suffixes before file discovery; compound suffixes are
 * supported and longest matches take precedence. Invalid configuration fails.
 * @param {unknown} extensions - Effective Next pageExtensions.
 * @returns {string[]} Validated suffixes, longest first.
 */
function validatePageExtensions(extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0
      || extensions.some((value) => typeof value !== 'string'
        || !/^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*$/.test(value))
      || new Set(extensions).size !== extensions.length) {
    throw new Error('Cannot reconcile routes: invalid pageExtensions.');
  }
  return [...extensions].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Read only route configuration, never .env files. The current repository uses
 * a CommonJS object config; unsupported future config forms fail for review.
 * Defaults come from this worktree's installed Next, not another checkout.
 * @param {string} root - Repository root.
 * @returns {string[]} Effective source-config page suffixes.
 */
function getConfiguredPageExtensions(root) {
  const alternateConfigs = ['next.config.mjs', 'next.config.ts'];
  if (alternateConfigs.some((file) => fs.existsSync(path.join(root, file)))) {
    throw new Error('Route inventory requires reviewed support for this Next config format.');
  }
  const configPath = path.join(root, 'next.config.js');
  const config = fs.existsSync(configPath) ? require(configPath) : {};
  if (!config || typeof config !== 'object' || typeof config.then === 'function') {
    throw new Error('Route inventory requires a resolved object Next config.');
  }
  const defaults = require(require.resolve('next/dist/server/config-shared', { paths: [root] }));
  return validatePageExtensions(config.pageExtensions ?? defaults.defaultConfig.pageExtensions);
}

/**
 * Map a Pages Router file to its route without assuming a .js suffix.
 * Keeps dynamic segments intact and excludes only exact framework-special roots.
 * @param {string} file - Pages-root-relative file using either path separator.
 * @param {string[]} extensions - Validated configured suffixes.
 * @returns {string|null} Route, or null for non-pages/framework-special files.
 */
function pageFileToRoute(file, extensions) {
  const normalized = file.replaceAll('\\', '/');
  const suffix = extensions.find((extension) => normalized.endsWith(`.${extension}`));
  if (!suffix) return null;
  const stem = normalized.slice(0, -(suffix.length + 1));
  const route = `/${stem.replace(/(^|\/)index$/, '').replace(/\/$/, '')}`;
  return FRAMEWORK_FILES.has(route) ? null : route;
}

/**
 * Discover all configured page files from the filesystem. Injectable filesystem
 * methods permit in-memory negative fixtures without creating actual routes.
 * @param {string} pagesRoot - Absolute src/pages path.
 * @param {string[]} extensions - Effective configured suffixes.
 * @param {object} filesystem - fs-compatible readdirSync provider.
 * @returns {Array<{file: string, route: string}>} Sorted routable sources.
 */
function discoverPageRoutes(pagesRoot, extensions, filesystem = fs) {
  const suffixes = validatePageExtensions(extensions);
  const discovered = [];
  /** Walk only this pages directory and collect extension-matched files. */
  function walk(directory) {
    for (const entry of filesystem.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const file = path.relative(pagesRoot, absolute).replaceAll('\\', '/');
        const route = pageFileToRoute(file, suffixes);
        if (route !== null) discovered.push({ file, route });
      } else {
        throw new Error('Unsupported pages filesystem entry; route discovery requires review.');
      }
    }
  }
  walk(pagesRoot);
  return discovered.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Reconcile discovered files against explicit classifications in both directions.
 * Reject duplicate file/route mappings and unknown policies before build checks.
 * @param {Array<object>} discovered - Files independently discovered on disk.
 * @param {Array<object>} inventory - Explicit file/route/policy entries.
 * @returns {void} Throws a filenames-only diagnostic on drift.
 */
function reconcilePageRoutes(discovered, inventory) {
  if (!Array.isArray(inventory)) throw new Error('Route inventory must be an array.');
  for (const [label, entries] of [['discovered', discovered], ['inventory', inventory]]) {
    const files = new Set();
    const routes = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.file !== 'string' || typeof entry.route !== 'string'
          || files.has(entry.file) || routes.has(entry.route)) {
        throw new Error(`Invalid or conflicting ${label} route mapping.`);
      }
      files.add(entry.file);
      routes.add(entry.route);
      if (label === 'inventory' && !POLICIES.has(entry.policy)) {
        throw new Error(`Unclassified route: ${entry.file}`);
      }
      if (label === 'inventory' && /-api$/.test(entry.policy) !== /^\/api(?:\/|$)/.test(entry.route)) {
        throw new Error(`Page/API policy mismatch: ${entry.file}`);
      }
    }
  }
  const byFile = new Map(inventory.map((entry) => [entry.file, entry]));
  for (const entry of discovered) {
    const expected = byFile.get(entry.file);
    if (!expected || expected.route !== entry.route) {
      throw new Error(`Unclassified or mismatched route: ${entry.file}`);
    }
    byFile.delete(entry.file);
  }
  if (byFile.size) throw new Error(`Missing inventoried routes: ${[...byFile.keys()].join(', ')}`);
}

module.exports = {
  FRAMEWORK_FILES,
  validatePageExtensions,
  getConfiguredPageExtensions,
  pageFileToRoute,
  discoverPageRoutes,
  reconcilePageRoutes,
};
