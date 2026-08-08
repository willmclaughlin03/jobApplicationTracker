/**
 * CHUNK-0 inventory tests for auth-capable response and route boundaries.
 *
 * Purpose: Keep every cookie-reading, refreshing, writing, or clearing path
 * visible and demonstrate the current private no-store coverage gap.
 * Connects to: the frozen cache/route inventory and future CHUNK-2/4/6 fixes.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  AUTH_CAPABLE_CACHE_INVENTORY,
  ROUTE_CLASSIFICATION_FIXTURES,
} = require('../testSupport/authV2ContractFixtures.js');

/**
 * Removes a review-only function suffix from an inventoried source path.
 *
 * @param {string} inventoryEntry - Path optionally followed by a hash label.
 * @returns {string} Repository-relative source path.
 */
function getInventoryFilePath(inventoryEntry) {
  return inventoryEntry.split('#')[0];
}

/**
 * Reads one current auth-capable source file without touching environment data.
 *
 * @param {string} inventoryEntry - Current-path inventory entry.
 * @returns {string} UTF-8 source text.
 */
function readInventorySource(inventoryEntry) {
  return fs.readFileSync(
    path.join(process.cwd(), getInventoryFilePath(inventoryEntry)),
    'utf8'
  );
}

const currentCachePaths = AUTH_CAPABLE_CACHE_INVENTORY.filter(
  (entry) => !entry.startsWith('future:')
);

const explicitSignoutCallerPaths = [
  'src/pages/index.js',
  'src/pages/billing/index.js',
  'src/pages/admin/users.js',
  'src/pages/admin/users/[id].js',
];

describe('auth-capable cache inventory', () => {
  it.each(currentCachePaths)('keeps inventoried source %s present', (inventoryEntry) => {
    expect(fs.existsSync(path.join(process.cwd(), getInventoryFilePath(inventoryEntry)))).toBe(true);
  });

  it.each(currentCachePaths)(
    'requires private no-store on every response path in %s',
    (inventoryEntry) => {
      expect(readInventorySource(inventoryEntry)).toContain('private, no-store');
    }
  );

  it('includes every planned route class without overlap', () => {
    const allPaths = Object.values(ROUTE_CLASSIFICATION_FIXTURES).flat();

    expect(new Set(allPaths).size).toBe(allPaths.length);
    expect(ROUTE_CLASSIFICATION_FIXTURES.protected).toContain('/');
    expect(ROUTE_CLASSIFICATION_FIXTURES.public).toContain('/404');
    expect(ROUTE_CLASSIFICATION_FIXTURES.unmatched).toContain('/missing');
  });

  it.each(explicitSignoutCallerPaths)(
    'does not let %s navigate to login without inspecting the sign-out result',
    (callerPath) => {
      const source = fs.readFileSync(path.join(process.cwd(), callerPath), 'utf8');

      expect(source).not.toMatch(
        /await\s+signOut\(\);\s*router\.(?:push|replace)\([']\/login[']\)/
      );
    }
  );
});
