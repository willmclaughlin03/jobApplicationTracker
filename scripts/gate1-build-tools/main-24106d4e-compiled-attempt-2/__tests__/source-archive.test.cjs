'use strict';
/* global describe, it, expect, jest, afterEach, Buffer, __dirname */

/** In-memory malformed archives plus one isolated real-Git conversion regression; no Docker or HTTP. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const zlib = require('node:zlib');
const tool = require('../source-archive.cjs');
const runner = require('../qualify-build.cjs');
const ROOT = path.resolve(__dirname, '../../../..');

/** Give synthetic member bytes their exact Git blob ID for comparison fixtures. */
function blob(name, content = Buffer.from('text\n')) {
  return { name, mode: '100644', oid: crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') };
}

/** Use the installed TAR header writer for synthetic inputs; never extract an archive. */
function pack(entries) {
  const { Header } = tool.loadReader(), chunks = [];
  for (const entry of entries) {
    const content = entry.content || Buffer.alloc(0), header = new Header({ path: entry.name, type: entry.type || 'File',
      size: entry.size ?? content.length, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0), linkpath: entry.linkpath || '' });
    header.encode(); chunks.push(header.block, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

/** Remove only this test's generated repository after checking its resolved workspace containment. */
function removeFixture(fixture, parent) {
  const target = path.resolve(fixture), allowed = path.resolve(parent) + path.sep;
  if (!target.startsWith(allowed) || target === path.resolve(parent)) throw new Error('synthetic_cleanup_boundary');
  fs.rmSync(target, { recursive: true, force: true });
}

/** Release mocks after each case so filesystem identities and archive limits do not leak across tests. */
afterEach(() => jest.restoreAllMocks());

describe('exact archive preflight', () => {
  const text = Buffer.from('text\n'), manifest = [blob('src/a.js', text)];

  it('accepts matching files and directories without writing or extracting', async () => {
    const archive = pack([{ name: 'src/', type: 'Directory' }, { name: 'src/a.js', content: text }]);
    const write = jest.spyOn(fs, 'writeFileSync');
    await expect(tool.verifyArchive(archive, manifest)).resolves.toMatchObject({ files: 1, entries: 2, bytes: 5, parserSha256: tool.PARSER_SHA256 });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects changed bytes without line-ending normalization', async () => {
    await expect(tool.verifyArchive(pack([{ name: 'src/a.js', content: Buffer.from('text\r\n') }]), manifest)).rejects.toThrow('archive_content');
  });

  it('rejects a missing expected file', async () => {
    await expect(tool.verifyArchive(pack([{ name: 'src/a.js', content: text }]), [...manifest, blob('src/b.js')])).rejects.toThrow('archive_missing');
  });

  it('rejects an unexpected file without retaining its name or body', async () => {
    const archive = pack([{ name: 'src/unknown.js', content: Buffer.from('synthetic-private-payload') }]);
    await expect(tool.verifyArchive(archive, manifest)).rejects.toMatchObject({ message: 'archive_extra', code: 'archive_extra' });
  });

  it('rejects duplicate members instead of accepting an extraction overwrite', async () => {
    await expect(tool.verifyArchive(pack([{ name: 'src/a.js', content: text }, { name: 'src/a.js', content: text }]), manifest)).rejects.toThrow('archive_duplicate');
  });

  it.each(['Link', 'SymbolicLink'])('rejects %s without following its target', async type => {
    await expect(tool.verifyArchive(pack([{ name: 'src/a.js', type, linkpath: 'synthetic-target' }]), manifest)).rejects.toThrow('archive_link');
  });

  it.each(['src/.env.local', 'src/../outside', '/src/a.js', 'src/bad\\path', 'src/.ssh/id_rsa'])('rejects unsafe member %s before payload use', async name => {
    await expect(tool.verifyArchive(pack([{ name, content: text }]), manifest)).rejects.toThrow('archive_path');
  });

  it('rejects duplicate manifest names', async () => {
    await expect(tool.verifyArchive(pack([{ name: 'src/a.js', content: text }]), [...manifest, ...manifest])).rejects.toThrow('archive_duplicate');
  });

  it('rejects a raw backslash path even when the reader normalizes it to an expected name', async () => {
    await expect(tool.verifyArchive(pack([{ name: 'src/bad\\path', content: text }]), [blob('src/bad/path', text)])).rejects.toThrow('archive_path');
  });

  it('rejects oversized declared payloads before consuming them', async () => {
    await expect(tool.verifyArchive(pack([{ name: 'src/a.js', size: tool.CAPS.payload + 1 }]), manifest)).rejects.toThrow('archive_limit');
  });

  it('rejects truncated member data and missing TAR end markers', async () => {
    const archive = pack([{ name: 'src/a.js', content: text }]);
    await expect(tool.verifyArchive(archive.subarray(0, 512), manifest)).rejects.toThrow('archive_format');
    await expect(tool.verifyArchive(archive.subarray(0, 1024), manifest)).rejects.toThrow('archive_format');
  });

  it('rejects corrupt checksums and compressed input', async () => {
    const archive = pack([{ name: 'src/a.js', content: text }]);
    const corrupt = Buffer.from(archive); corrupt[0] ^= 1;
    await expect(tool.verifyArchive(corrupt, manifest)).rejects.toThrow('archive_format');
    await expect(tool.verifyArchive(zlib.gzipSync(archive), manifest)).rejects.toThrow('archive_format');
  });

  it('rejects a changed parser before invoking it', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('different reader'));
    expect(() => tool.loadReader()).toThrow('archive_parser');
  });

  it('uses archive-specific Git settings without replacing checkout validation', async () => {
    const archive = pack([{ name: 'src/a.js', content: text }]), git = jest.fn().mockResolvedValue(archive);
    await expect(tool.buildArchive(git, 'a'.repeat(40), ['src'], manifest)).resolves.toHaveProperty('verification.files', 1);
    expect(git).toHaveBeenCalledWith(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', 'a'.repeat(40), '--', 'src'], { cap: tool.CAPS.archive });
  });

  it('stops archive preparation on a mismatch instead of returning an approvable result', async () => {
    const git = jest.fn().mockResolvedValue(pack([{ name: 'src/a.js', content: Buffer.from('changed') }]));
    await expect(tool.buildArchive(git, 'a'.repeat(40), ['src'], manifest)).rejects.toThrow('archive_content');
    expect(git).toHaveBeenCalledTimes(1);
  });
});

describe('real Git archive conversion regression', () => {
  it('reproduces CRLF archive drift and preserves text/binary committed blobs with the correction', async () => {
    const parent = path.join(ROOT, '.tmp/gate1-archive-tests');
    fs.mkdirSync(parent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(parent, 'attempt-2-'));
    /** Run only fixture-local Git with fixed identity, no hooks/network, finite output and discarded diagnostics. */
    function git(args) {
      try {
        return execFileSync('git', ['-C', fixture, '-c', 'core.autocrlf=true', '-c', 'core.filemode=false',
          '-c', 'core.hooksPath=' + path.join(fixture, 'disabled-hooks'), '-c', 'commit.gpgsign=false',
          '-c', 'user.name=Gate1 synthetic fixture', '-c', 'user.email=gate1@example.invalid', ...args],
        { env: runner.hostEnvironment(), timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { throw new Error('synthetic_git_failed'); }
    }
    try {
      git(['init', '--quiet', '--template=']);
      fs.mkdirSync(path.join(fixture, 'src'));
      const text = Buffer.from('alpha\nbeta\n'), binary = Buffer.from([0, 255, 10, 13, 128, 0]);
      fs.writeFileSync(path.join(fixture, 'src/a.js'), text);
      fs.writeFileSync(path.join(fixture, 'src/b.bin'), binary);
      git(['-c', 'core.autocrlf=false', 'add', '--', 'src/a.js', 'src/b.bin']);
      git(['commit', '--quiet', '--no-gpg-sign', '-m', 'synthetic archive fixture']);
      const source = git(['rev-parse', 'HEAD']).toString().trim();
      const manifest = runner.sourceSelection(git(['ls-tree', '-r', '-z', source]));
      fs.unlinkSync(path.join(fixture, 'src/a.js'));
      git(['checkout-index', '--force', '--all']);
      expect(fs.readFileSync(path.join(fixture, 'src/a.js'))).toEqual(Buffer.from('alpha\r\nbeta\r\n'));
      await expect(tool.verifyArchive(git(['archive', '--format=tar', source, '--', 'src']), manifest)).rejects.toThrow('archive_content');
      const corrected = await tool.buildArchive(async args => git(args), source, ['src'], manifest);
      expect(corrected.verification).toMatchObject({ files: 2, bytes: text.length + binary.length });
      // The source of an archive remains the selected commit even when fixture working bytes change.
      fs.writeFileSync(path.join(fixture, 'src/a.js'), 'uncommitted synthetic text');
      const repeated = await tool.buildArchive(async args => git(args), source, ['src'], manifest);
      expect(repeated.archive).toEqual(corrected.archive);
    } finally {
      removeFixture(fixture, parent);
    }
  }, 60000);
});
