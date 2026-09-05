const path = require('node:path');
const {
  discoverPageRoutes, reconcilePageRoutes, pageFileToRoute, validatePageExtensions,
  getConfiguredPageExtensions,
} = require('../pageRouteInventory.js');

/** Supply a small in-memory directory tree to exercise the real recursive scanner. */
function fixtureFilesystem(files) {
  return {
    /** Return only immediate children as fs-style Dirents, without disk writes. */
    readdirSync(directory) {
      const relative = path.relative(path.resolve('fixture-pages'), directory).replaceAll('\\', '/');
      const prefix = relative ? `${relative}/` : '';
      const children = new Map();
      for (const file of files.filter((candidate) => candidate.startsWith(prefix))) {
        const tail = file.slice(prefix.length);
        const name = tail.split('/')[0];
        children.set(name, tail.includes('/'));
      }
      return [...children].map(([name, directoryEntry]) => ({
        name,
        /** Match fs.Dirent for fixture directory nodes. */
        isDirectory: () => directoryEntry,
        /** Match fs.Dirent for fixture file nodes. */
        isFile: () => !directoryEntry,
      }));
    },
  };
}

describe('configured page discovery', () => {
  const root = path.resolve('fixture-pages');
  const defaults = ['tsx', 'ts', 'jsx', 'js'];

  it.each(defaults)('rejects a newly added unclassified .%s protected page', (extension) => {
    const file = `billing/history.${extension}`;
    const found = discoverPageRoutes(root, defaults, fixtureFilesystem([file]));
    expect(found).toEqual([{ file, route: '/billing/history' }]);
    expect(() => reconcilePageRoutes(found, [])).toThrow('Unclassified');
  });

  it.each(['mdx', 'page.tsx'])('honors configured %s suffixes', (extension) => {
    const file = `admin/history.${extension}`;
    const found = discoverPageRoutes(root, [extension], fixtureFilesystem([file, 'ignored.js']));
    expect(found).toEqual([{ file, route: '/admin/history' }]);
    expect(() => reconcilePageRoutes(found, [])).toThrow('Unclassified');
  });

  it('uses this checkout configuration and installed defaults', () => {
    expect(getConfiguredPageExtensions(process.cwd()).sort()).toEqual([...defaults].sort());
  });

  it('handles index routes, Windows paths and compound suffixes', () => {
    const extensions = validatePageExtensions(['js', 'page.tsx', 'tsx']);
    expect(pageFileToRoute('index.js', extensions)).toBe('/');
    expect(pageFileToRoute('billing\\index.page.tsx', extensions)).toBe('/billing');
    expect(pageFileToRoute('admin/users/[id].page.tsx', extensions)).toBe('/admin/users/[id]');
  });

  it('excludes only exact framework roots and unsupported extensions', () => {
    const found = discoverPageRoutes(root, defaults, fixtureFilesystem([
      '_app.tsx', '_error.js', '_document.jsx', '_internal.js',
      'billing/_history.ts', 'billing/index.jsx', 'notes.md',
    ]));
    expect(found.map((entry) => entry.route).sort()).toEqual([
      '/_internal', '/billing', '/billing/_history',
    ]);
  });

  it('rejects conflicting routes and missing inventoried files', () => {
    const found = discoverPageRoutes(root, defaults, fixtureFilesystem([
      'billing/index.jsx', 'billing.tsx',
    ]));
    expect(() => reconcilePageRoutes(found, [])).toThrow('conflicting');
    expect(() => reconcilePageRoutes([], [
      { file: 'index.js', route: '/', policy: 'protected-page' },
    ])).toThrow('Missing');
  });

  it('requires exact file/route mappings and known policies', () => {
    const found = [{ file: 'index.js', route: '/' }];
    expect(() => reconcilePageRoutes(found, [{ ...found[0], policy: 'protected-page' }])).not.toThrow();
    expect(() => reconcilePageRoutes(found, [{ ...found[0], route: '/wrong', policy: 'protected-page' }])).toThrow('mismatched');
    expect(() => reconcilePageRoutes(found, [{ ...found[0], policy: 'unknown' }])).toThrow('Unclassified');
    expect(() => reconcilePageRoutes(found, [{ ...found[0], policy: 'protected-api' }])).toThrow('policy mismatch');
  });

  it.each([[], null, ['js', 'js'], ['../js'], ['']])('rejects invalid extension configuration %j', (extensions) => {
    expect(() => validatePageExtensions(extensions)).toThrow('pageExtensions');
  });
});
