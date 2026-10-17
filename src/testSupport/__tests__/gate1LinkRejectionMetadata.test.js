'use strict';

/** Synthetic metadata only. No test accesses retained Linux output, comparisons or Docker. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const r = require('../../../scripts/gate1-link-rejection-metadata');
const { createHash } = require('node:crypto');

/** Hash a synthetic privacy sentinel to ensure neither its text nor its fingerprint is emitted. */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
const APPROVAL = 'a'.repeat(64), PRIVATE = 'SYNTHETIC_PRIVATE_PATH_123456789';

/** Build a descriptor-backed virtual filesystem; regular-file reads and external-path lookups are absent. */
function tree(entries = {}, options = {}) {
  const nodes = new Map(), handles = new Map(), calls = [], counts = new Map();
  let nextFd = 10, nextInode = 1, clock = 0, maximumHandles = 0;
  /** Add immutable-by-default metadata with explicit overrides for hard links and mutation fixtures. */
  function add(name, value = {}) {
    const kind = value.kind || 'file';
    const node = { dev: 1, ino: nextInode++, mode: kind === 'directory' ? 16832 : 33152,
      size: kind === 'symlink' ? Buffer.byteLength(value.target || '') : 0,
      nlink: kind === 'directory' ? 2 : 1, mtimeMs: 1, ctimeMs: 1, kind, ...value };
    nodes.set(name, node); return node;
  }
  for (const name of r.lib.ancestors) add(name, { kind: 'directory' });
  for (const [relative, value] of Object.entries(entries)) add(`${r.lib.output}/${relative}`, value);
  if (options.ancestor) Object.assign(nodes.get(options.ancestor.path), options.ancestor.value);
  /** Snapshots copy fields so mutation cannot retroactively change an earlier lstat result. */
  function snapshot(value) {
    if (!value) throw Object.assign(Error(PRIVATE), { code: 'ENOENT' });
    const copied = { ...value };
    return { ...copied, isDirectory: () => copied.kind === 'directory', isFile: () => copied.kind === 'file',
      isSymbolicLink: () => copied.kind === 'symlink' };
  }
  /** Accept only the fixed mount root and owned descriptor paths with one child component. */
  function resolve(name) {
    if (name === '/evidence') return name;
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/([^/]+))?$/.exec(name);
    assert.ok(match, 'no arbitrary target path');
    const handle = handles.get(Number(match[1])); assert.ok(handle, 'owned descriptor');
    assert.ok(!['.', '..'].includes(match[2]));
    return match[2] ? `${handle.logical}/${match[2]}` : handle.logical;
  }
  /** Log metadata and expose a mutation seam; thrown messages deliberately contain a private sentinel. */
  function log(operation, logical) {
    calls.push([operation, logical]); const key = `${operation}:${logical}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    options.mutate?.({ operation, logical, count: counts.get(key), nodes, add, expire: () => { clock = 18000; } });
  }
  /** Return native insertion order without following any symlink or reading a file. */
  function children(logical) { return [...nodes.keys()].filter(name => path.posix.dirname(name) === logical).map(name => path.posix.basename(name)); }
  const io = {
    constants: { O_RDONLY: 0, O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_NONBLOCK: 2048 },
    /** lstat observes only the anchored entry. */
    lstatSync(name) { const logical = resolve(name); log('lstat', logical); return snapshot(nodes.get(logical)); },
    /** Only ordinary directories may be opened, with every reviewed no-follow flag. */
    openSync(name, flags) {
      const logical = resolve(name); log('open', logical); assert.equal(flags, 198656);
      assert.equal(nodes.get(logical)?.kind, 'directory');
      const fd = nextFd++; handles.set(fd, { logical, node: nodes.get(logical) });
      maximumHandles = Math.max(maximumHandles, handles.size); return fd;
    },
    /** A descriptor remains bound to its original node after replacement of a directory name. */
    fstatSync(fd) { const handle = handles.get(fd); assert.ok(handle); log('fstat', handle.logical); return snapshot(handle.node); },
    /** Closing removes exactly one owned descriptor. */
    closeSync(fd) { const handle = handles.get(fd); assert.ok(handle); log('close', handle.logical); handles.delete(fd); },
    /** Only symlink text can be read; no file-content API exists in the fake filesystem. */
    readlinkSync(name, config) {
      const logical = resolve(name); log('readlink', logical); assert.equal(config.encoding, 'buffer');
      assert.equal(nodes.get(logical)?.kind, 'symlink'); return Buffer.from(nodes.get(logical).target);
    },
    /** Stream directory entries in native order with the scanner's default buffer size. */
    opendirSync(name, config) {
      const logical = resolve(name); log('opendir', logical);
      assert.deepEqual(Object.keys(config).sort(), ['bufferSize', 'encoding']); assert.equal(config.bufferSize, 32); assert.equal(config.encoding, 'buffer');
      const names = children(logical); let cursor = 0, closed = false;
      return {
        /** Yield a directory name, including controlled malformed/duplicate fixtures. */
        readSync() {
          assert.equal(closed, false); log('read_directory', logical);
          if (options.badName && logical === r.lib.output && cursor++ === 0) return { name: options.badName };
          if (options.generated && logical === r.lib.output) {
            if (cursor >= options.generated) return null;
            const index = cursor++, name = `file${index}`;
            if (!nodes.has(`${logical}/${name}`)) add(`${logical}/${name}`, options.generatedAliases ?
              index === 0 ? { nlink: 2 } : { kind: 'symlink', target: '/outside' } : {});
            return { name: Buffer.from(name) };
          }
          return cursor < names.length ? { name: Buffer.from(names[cursor++]) } : null;
        },
        /** Always release the directory iterator; optionally simulate a close failure. */
        closeSync() { assert.equal(closed, false); closed = true; log('close_iterator', logical); if (options.closeFailure) throw Error(PRIVATE); },
      };
    },
    /** The reader counts each directory-entry operation as metadata. */
    readDirectory(iterator) { return iterator.readSync(); },
  };
  return { io, nodes, calls, handles, counts, snapshot, children, now: () => clock, maximumHandles: () => maximumHandles };
}

/** Run one virtual observation and independently validate both privacy and descriptor cleanup. */
function observe(entries, options) {
  const fake = tree(entries, options), result = r.lib.inspect(APPROVAL, fake.io, fake.now);
  assert.equal(fake.handles.size, 0); assert.ok(fake.maximumHandles() <= 70);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
  r.validateReport(Buffer.from(JSON.stringify(result)), APPROVAL);
  return { ...fake, result };
}

/** Create two names of one inode, optionally reporting one additional unobserved hard-link name. */
function linked(nlink = 2) { return { first: { ino: 1000, nlink }, second: { ino: 1000, nlink } }; }

/** Run the unchanged scanner's exported inventory against the same virtual tree as a differential oracle. */
async function oracle(entries, options = {}) {
  const fake = tree(entries, options), calls = [];
  const promises = {
    /** Observe fixed logical metadata for the oracle; no actual filesystem operation runs. */
    async lstat(name) { calls.push(name); return fake.snapshot(fake.nodes.get(name)); },
    /** Preserve native directory order for the original scanner's async iterator. */
    async opendir(name) {
      return { /** Yield only synthetic names. */ async *[Symbol.asyncIterator]() {
        for (const child of fake.children(name)) yield { name: child };
      } };
    },
    /** Return private synthetic symlink bytes only to the inventory stage. */
    async readlink(name) { return Buffer.from(fake.nodes.get(name).target); },
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../../scripts/gate1-build-artifact-privacy.js'), 'utf8');
  const sandboxModule = { exports: {} };
  vm.runInNewContext(source, { module: sandboxModule, exports: sandboxModule.exports, Buffer, __dirname: path.resolve(__dirname, '../../../scripts'),
    process: { platform: 'linux' }, require: name => name === 'node:fs' ? { promises } : name === 'node:path' ? path.posix : require(name) });
  const scanner = sandboxModule.exports, state = { limits: scanner.LIMITS, now: () => 0, started: 0, bytesInspected: 0, bytesRead: 0, decodedBytes: 0, linkPolicy: scanner.LINK_POLICY };
  try { await scanner.inventory(r.lib.output, state); return { failure: null, last: calls.at(-1) }; }
  catch (error) { return { failure: error.code, last: calls.at(-1), stat: fake.nodes.get(calls.at(-1)) }; }
}

test('two physical names account for the selected inode without opening content', () => {
  const { result, calls } = observe(linked());
  assert.equal(result.outcome, 'diagnosed'); assert.equal(result.rejection, 'file_link_count');
  assert.equal(result.observedLinkCount, 2); assert.equal(result.matchingNames, 2);
  assert.equal(result.accounting, 'all_names_accounted_for_inside_output'); assert.equal(result.inventoryStable, true);
  assert.equal(result.counters.walksCompleted, 2); assert.equal(result.counters.entryVisits, 4);
  assert.ok(!calls.some(([op, name]) => op === 'open' && /\/(first|second)$/.test(name)));
});

test('unobserved hard-link names are reported without searching outside output', () => {
  const { result } = observe(linked(3));
  assert.equal(result.outcome, 'diagnosed'); assert.equal(result.matchingNames, 2);
  assert.equal(result.accounting, 'not_all_names_accounted_for_inside_output');
  assert.equal(result.artifactPrivacy, 'unqualified'); assert.equal(result.historicalFirstFailureIdentified, false);
});

test('directory aliases do not duplicate a hard-link count or trigger outside traversal', () => {
  const { result, calls } = observe({ ...linked(), alias: { kind: 'symlink', target: '/outside/private' } });
  assert.equal(result.matchingNames, 2); assert.equal(result.counters.linkTexts, 0);
  assert.ok(!calls.some(([op]) => op === 'readlink'));
});

test('breadth-first selection agrees with the scanner when depth-first traversal would find another link', async () => {
  const entries = { nested: { kind: 'directory' }, rootHard: { ino: 900, nlink: 2 },
    'nested/link': { kind: 'symlink', target: '../target' }, target: { kind: 'directory' }, 'target/other': { ino: 900, nlink: 2 } };
  const source = await oracle(entries), { result } = observe(entries);
  assert.equal(source.failure, 'link'); assert.equal(source.last, `${r.lib.output}/rootHard`);
  assert.equal(result.observedLinkCount, source.stat.nlink); assert.equal(result.matchingNames, 2);
  assert.equal(result.counters.linkTexts, 0);
});

test('a benign earlier symlink is checked without resolving or following its target', async () => {
  const entries = { alias: { kind: 'symlink', target: '../outside' }, ...linked() };
  const source = await oracle(entries), { result, calls } = observe(entries);
  assert.equal(source.failure, 'link'); assert.equal(result.rejection, 'file_link_count');
  assert.equal(result.counters.linkTexts, 1); assert.equal(result.counters.linkBytes, 10);
  assert.ok(!calls.some(([, name]) => name.includes('/outside')));
});

test('ancestor symlink selection agrees with the scanner and reads no link text or output entries', async () => {
  const options = { ancestor: { path: r.lib.ancestors[2], value: { kind: 'symlink', target: PRIVATE } } };
  assert.equal((await oracle({}, options)).failure, 'link');
  const { result } = observe({}, options);
  assert.equal(result.rejection, 'ancestor_symlink'); assert.equal(result.outcome, 'diagnosed');
  assert.equal(result.counters.entryVisits, 0); assert.equal(result.counters.linkTexts, 0);
});

test('ordinary output does not falsely claim a link failure or a privacy pass', async () => {
  const entries = { 'config.json': {}, static: { kind: 'directory' }, 'static/app.js': {} };
  assert.equal((await oracle(entries)).failure, null);
  const { result } = observe(entries); assert.equal(result.outcome, 'not_reproduced');
  assert.equal(result.counters.walksCompleted, 1); assert.equal(result.inventoryStable, false);
});

for (const [label, entries, expected] of [
  ['forbidden', { '.env': {}, ...linked() }, 'forbidden_file'],
  ['bad path', { 'bad:name': {}, ...linked() }, 'path'],
  ['special', { fifo: { kind: 'special' }, ...linked() }, 'file_type'],
  ['oversized file', { large: { size: 67108865 }, ...linked() }, 'file_size'],
  ['oversized link', { alias: { kind: 'symlink', target: 'x', size: 4097 }, ...linked() }, 'file_size'],
]) test(`earlier ${label} guard agrees with original scanner and blocks attribution`, async () => {
  assert.equal((await oracle(entries)).failure, expected);
  const { result } = observe(entries); assert.equal(result.reason, expected); assert.equal(result.rejection, null);
});

for (const [label, mutate] of [
  ['link count', ({ operation, logical, count, nodes }) => { if (operation === 'lstat' && logical.endsWith('/first') && count === 2) nodes.get(logical).nlink++; }],
  ['file replacement', ({ operation, logical, count, nodes }) => { if (operation === 'lstat' && logical.endsWith('/first') && count === 2) nodes.get(logical).ino++; }],
  ['added entry', ({ operation, logical, count, add }) => { if (operation === 'opendir' && logical === r.lib.output && count === 2) add(`${logical}/added`); }],
  ['removed entry', ({ operation, logical, count, nodes }) => { if (operation === 'opendir' && logical === r.lib.output && count === 2) nodes.delete(`${logical}/second`); }],
]) test(`${label} mutation invalidates complete hard-link accounting`, () => {
  const { result } = observe(linked(), { mutate });
  assert.equal(result.outcome, 'inconclusive'); assert.equal(result.reason, 'changed');
  assert.equal(result.matchingNames, null); assert.equal(result.inventoryStable, false); assert.equal(result.accounting, 'inconclusive');
});

test('directory replacement while queued cannot redirect traversal through a symlink', () => {
  const { result } = observe({ ...linked(), nested: { kind: 'directory' } }, { mutate({ operation, logical, count, nodes }) {
    if (operation === 'lstat' && logical.endsWith('/nested') && count === 2) nodes.set(logical, { ...nodes.get(logical), kind: 'symlink', ino: 500, target: '/outside' });
  } });
  assert.equal(result.outcome, 'inconclusive'); assert.equal(result.reason, 'changed');
});

test('different devices and duplicate directory identities cannot inflate physical-name accounting', () => {
  assert.equal(observe({ ...linked(), cross: { kind: 'directory', dev: 2 } }).result.reason, 'device');
  assert.equal(observe({ ...linked(), one: { kind: 'directory', ino: 900 }, two: { kind: 'directory', ino: 900 } }).result.reason, 'directory_identity');
});

test('inconsistent inode metadata and excess names never become a containment claim', () => {
  assert.equal(observe({ ...linked(), second: { ino: 1000, nlink: 3 } }).result.reason, 'changed');
  assert.equal(observe({ ...linked(), third: { ino: 1000, nlink: 2 } }).result.reason, 'changed');
  assert.equal(observe({ first: { nlink: 0 } }).result.reason, 'changed');
});

test('private path text and filesystem exceptions never enter reports or hashes', () => {
  const { result } = observe({ [PRIVATE]: { nlink: 2 } });
  assert.equal(result.matchingNames, 1); assert.ok(!JSON.stringify(result).includes(hash(PRIVATE)));
  const failed = observe(linked(), { mutate() { throw Error(PRIVATE); } }).result;
  assert.equal(failed.reason, 'unreadable'); assert.ok(!JSON.stringify(failed).includes(PRIVATE));
});

test('deadline and iterator cleanup failure keep partial accounting inconclusive', () => {
  const deadline = observe(linked(), { mutate({ operation, expire }) { if (operation === 'read_directory') expire(); } }).result;
  assert.equal(deadline.reason, 'deadline');
  assert.equal(observe(linked(), { closeFailure: true }).result.outcome, 'inconclusive');
});

for (const [label, name, expected] of [['oversized', Buffer.alloc(256, 97), 'path_limit'],
  ['invalid UTF8', Buffer.from([255]), 'encoding'], ['control', Buffer.from('bad\0name'), 'path']]) {
  test(`${label} directory names stop without disclosure`, () => assert.equal(observe({}, { badName: name }).result.reason, expected));
}

test('depth, file-count and aggregate file-size limits precede unbounded metadata work', () => {
  const nested = {}; let relative = '';
  for (let i = 0; i < 65; i++) { relative += (relative ? '/' : '') + 'd'; nested[relative] = { kind: 'directory' }; }
  assert.equal(observe({ ...linked(), ...nested }).result.reason, 'depth_limit');
  assert.equal(observe({}, { generated: 25001 }).result.reason, 'file_limit');
  const large = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`large${i}`, { size: 67108864 }]));
  assert.equal(observe(large).result.reason, 'total_bytes');
});

test('link-text total is bounded independently of regular-file content', () => {
  const entries = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`alias${i}`, { kind: 'symlink', target: 'a'.repeat(4096) }]));
  assert.equal(observe(entries).result.reason, 'total_bytes');
});

test('entry cap includes symlinks without following them or claiming partial accounting', () => {
  const { result } = observe({}, { generated: 50001, generatedAliases: true });
  assert.equal(result.reason, 'entry_limit'); assert.equal(result.counters.entryVisits, 50000);
  assert.equal(result.matchingNames, null); assert.equal(result.counters.linkTexts, 0);
});

test('aggregate private path storage is bounded before an incomplete inventory can qualify', () => {
  const entries = { ...linked() }; let parent = '';
  for (let i = 0; i < 14; i++) {
    parent += (parent ? '/' : '') + 'd'.repeat(200); entries[parent] = { kind: 'directory' };
  }
  for (let i = 0; i < 2800; i++) entries[`${parent}/${'x'.repeat(245)}${i}`] = { kind: 'symlink', target: '/outside' };
  const { result } = observe(entries);
  assert.equal(result.reason, 'path_budget'); assert.equal(result.matchingNames, null);
});

test('shared metadata-call budget includes reopening and releasing directory ancestors', () => {
  const entries = { ...linked() }; let parent = '';
  for (let i = 0; i < 40; i++) { parent += (parent ? '/' : '') + 'd'; entries[parent] = { kind: 'directory' }; }
  for (let i = 0; i < 2200; i++) entries[`${parent}/directory${i}`] = { kind: 'directory' };
  const { result } = observe(entries);
  assert.equal(result.reason, 'metadata_limit'); assert.ok(result.counters.metadataCalls <= 500000);
  assert.equal(result.matchingNames, null);
});

test('precision-losing inode metadata and final cleanup mutations remain inconclusive', () => {
  assert.equal(observe({ first: { ino: Number.MAX_SAFE_INTEGER + 1, nlink: 2 } }).result.reason, 'metadata');
  const { result } = observe(linked(), { mutate({ operation, logical, nodes }) {
    if (operation === 'close_iterator' && logical === r.lib.output) nodes.get('/evidence').ctimeMs++;
  } });
  assert.equal(result.reason, 'cleanup'); assert.equal(result.inventoryStable, false); assert.equal(result.matchingNames, null);
});

test('serialized Linux reader has the same behavior with no application or scanner import', () => {
  const fake = tree(linked()), proc = { stdout: { write(value) { proc.text = value; } }, text: '' };
  vm.runInNewContext(r.readerInput(APPROVAL).toString(), { Buffer, process: proc, require: name => {
    assert.ok(['node:fs', 'node:path', 'node:util', 'node:perf_hooks'].includes(name));
    return name === 'node:fs' ? fake.io : name === 'node:perf_hooks' ? { performance: { now: fake.now } } : require(name);
  } });
  assert.equal(r.validateReport(Buffer.from(proc.text), APPROVAL).matchingNames, 2); assert.equal(fake.handles.size, 0);
});

test('report validator rejects arbitrary fields, inconsistent accounting, duplicate keys and oversized output', () => {
  const base = observe(linked()).result;
  for (const patch of [{ private: PRIVATE }, { approval: 'f'.repeat(64) }, { reason: PRIVATE }, { matchingNames: 3 },
    { matchingNames: 0 }, { matchingNames: -0 }, { observedLinkCount: 1 }, { observedLinkCount: '2' },
    { inventoryStable: false }, { outcome: 'inconclusive' }, { rejection: 'ancestor_symlink' },
    { accounting: 'not_all_names_accounted_for_inside_output' }, { historicalFirstFailureIdentified: true },
    { counters: { ...base.counters, walksCompleted: 1 } }, { counters: { ...base.counters, fileContentBytes: 1 } },
    { counters: { ...base.counters, inode: 123 } }]) {
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify({ ...base, ...patch })), APPROVAL));
  }
  assert.throws(() => r.validateReport(Buffer.alloc(4097), APPROVAL));
  assert.throws(() => r.validateReport(Buffer.from('{"scope":1,"scope":2}'), APPROVAL));
});
