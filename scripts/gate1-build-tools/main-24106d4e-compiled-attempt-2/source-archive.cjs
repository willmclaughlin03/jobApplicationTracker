'use strict';
/* global Buffer, setTimeout, clearTimeout */

/** Host-only archive preparation; existing TAR parsing is pinned and never extracts files. */
const fs = require('node:fs');
const crypto = require('node:crypto');

// Host preparation supports the existing shared installation and the application's locked Next version.
const PARSER_SHA256S = Object.freeze({
  '16.2.12': '7f02d0edb684eafcc2bef85c66b3ab6083c26adfc5b583a6726a910cffa2c603',
  '16.3.3': 'afc929b535e65468c4891a31b2243f3e6a24874707135b8e183ddc4e7cabba77',
});
const CAPS = Object.freeze({ archive: 128 * 1024 * 1024, payload: 128 * 1024 * 1024, files: 4096, entries: 8192, metadata: 256 * 1024, ms: 30000 });
const CODES = Object.freeze(['archive_parser', 'archive_format', 'archive_path', 'archive_limit', 'archive_duplicate', 'archive_link', 'archive_extra', 'archive_missing', 'archive_content']);

/** Retain only fixed failure categories; paths, contents and parser messages are excluded. */
class ArchiveError extends Error {
  /** Restrict archive errors to the reviewed vocabulary used by the qualification runner. */
  constructor(code) { super(CODES.includes(code) ? code : 'archive_format'); this.code = this.message; }
}

/** Restrict member names before any payload is inspected; names are POSIX application paths. */
function safeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\\:]/.test(name) && !name.startsWith('/') &&
    [...name].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && !part.toLowerCase().startsWith('.env') &&
      !['.git', '.vercel', '.aws', '.ssh', '.npmrc', '.pypirc', '.netrc', 'node_modules', '.next', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519'].includes(part.toLowerCase()) &&
      !/\.(pem|key|p12|pfx)$/i.test(part));
}

/** Return an approved standalone reader and its actual digest for the contract; never execute the Next application. */
function loadReader() {
  try {
    // NODE_PATH can supply the primary checkout's dependencies for an isolated linked worktree.
    const readerPath = require.resolve('next/dist/compiled/tar/index.min.js');
    const stat = fs.lstatSync(readerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new ArchiveError('archive_parser');
    const parserSha256 = crypto.createHash('sha256').update(fs.readFileSync(readerPath)).digest('hex');
    if (!Object.values(PARSER_SHA256S).includes(parserSha256)) throw new ArchiveError('archive_parser');
    const reader = require(readerPath);
    if (typeof reader.Parser !== 'function' || typeof reader.Header !== 'function') throw new ArchiveError('archive_parser');
    return { reader, parserSha256 };
  } catch { throw new ArchiveError('archive_parser'); }
}

/** Override checkout conversion only for archive creation; committed attributes remain subject to exact verification. */
function archiveArguments(source, roots) {
  if (!/^[a-f0-9]{40}$/.test(source) || !Array.isArray(roots) || !roots.length || roots.length > CAPS.files || roots.some(root => !safeName(root))) throw new ArchiveError('archive_path');
  return ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', source, '--', ...roots];
}

/** Compare each regular member to its committed Git blob ID without extraction, normalization or link traversal. */
function verifyArchive(bytes, manifest) {
  return new Promise((resolve, reject) => {
    let parser, parserSha256, timer, done = false, eof = false, entries = 0, payloadBytes = 0;
    const expected = new Map(), seen = new Set(), found = new Set();
    /** Finish once, clear the finite timer and expose only fixed archive error categories. */
    function finish(error) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error instanceof ArchiveError ? error : new ArchiveError('archive_format'));
      else resolve({ files: found.size, entries, bytes: payloadBytes, parserSha256 });
    }
    /** Count ordinary and metadata entries together, rejecting oversized archives before further processing. */
    function countEntry() { if (++entries > CAPS.entries) throw new ArchiveError('archive_limit'); }
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length > CAPS.archive || bytes.length < 1024 || bytes.length % 512 !== 0) throw new ArchiveError('archive_format');
      if (!Array.isArray(manifest) || !manifest.length || manifest.length > CAPS.files) throw new ArchiveError('archive_limit');
      for (const entry of manifest) {
        if (!entry || !safeName(entry.name) || !/^[a-f0-9]{40}$/.test(entry.oid) || !['100644', '100755'].includes(entry.mode)) throw new ArchiveError('archive_path');
        if (expected.has(entry.name)) throw new ArchiveError('archive_duplicate');
        expected.set(entry.name, entry.oid);
      }
      const loaded = loadReader(), reader = loaded.reader, first = new reader.Header(bytes.subarray(0, 512));
      parserSha256 = loaded.parserSha256;
      // A valid uncompressed first header avoids the reader's automatic decompression paths.
      if (!first.cksumValid || first.nullBlock || !first.path) throw new ArchiveError('archive_format');
      parser = new reader.Parser({ strict: true, maxMetaEntrySize: CAPS.metadata, brotli: false, zstd: false });
      parser.on('error', () => finish(new ArchiveError('archive_format')));
      parser.on('warn', () => finish(new ArchiveError('archive_format')));
      parser.on('ignoredEntry', () => finish(new ArchiveError('archive_format')));
      parser.on('eof', () => { eof = true; });
      parser.on('meta', countEntry);
      parser.on('entry', entry => {
        if (done) { entry.resume(); return; }
        countEntry();
        // ReadEntry normalizes Windows separators; require agreement with the original decoded header.
        if (entry.header?.path !== entry.path) throw new ArchiveError('archive_path');
        const directory = entry.type === 'Directory', name = directory ? entry.path.replace(/\/$/, '') : entry.path;
        if (!safeName(name)) throw new ArchiveError('archive_path');
        if (seen.has(name)) throw new ArchiveError('archive_duplicate');
        seen.add(name);
        if (directory) {
          if (entry.size !== 0 || expected.has(name)) throw new ArchiveError('archive_format');
          entry.resume(); return;
        }
        if (entry.type === 'Link' || entry.type === 'SymbolicLink') throw new ArchiveError('archive_link');
        if (entry.type !== 'File') throw new ArchiveError('archive_format');
        if (!expected.has(name)) throw new ArchiveError('archive_extra');
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (payloadBytes += entry.size) > CAPS.payload) throw new ArchiveError('archive_limit');
        const hash = crypto.createHash('sha1').update(`blob ${entry.size}\0`);
        let received = 0;
        entry.on('error', () => finish(new ArchiveError('archive_format')));
        entry.on('data', block => {
          if (done) return;
          if (!Buffer.isBuffer(block) || (received += block.length) > entry.size) throw new ArchiveError('archive_format');
          hash.update(block);
        });
        entry.on('end', () => {
          if (done) return;
          if (received !== entry.size) throw new ArchiveError('archive_format');
          if (hash.digest('hex') !== expected.get(name)) throw new ArchiveError('archive_content');
          found.add(name);
        });
        entry.resume();
      });
      parser.on('end', () => finish(!eof ? new ArchiveError('archive_format') : found.size === expected.size ? null : new ArchiveError('archive_missing')));
      timer = setTimeout(() => finish(new ArchiveError('archive_limit')), CAPS.ms);
      parser.end(bytes);
    } catch (error) { finish(error); }
  });
}

/** Generate and fully verify one in-memory archive before the caller hashes its approval contract. */
async function buildArchive(runGit, source, roots, manifest) {
  const archive = await runGit(archiveArguments(source, roots), { cap: CAPS.archive });
  const verification = await verifyArchive(archive, manifest);
  return { archive, verification };
}

module.exports = { PARSER_SHA256S, CAPS, CODES, ArchiveError, archiveArguments, loadReader, verifyArchive, buildArchive };
