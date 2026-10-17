'use strict';

/** Fixed-output metadata library. Importing or directly running this module never inspects artifacts.
 * A separately reviewed local adapter supplies execution approval, Docker isolation and evidence retention.
 */
const parser = require('./gate1-vercel-build-diagnostic').readerLibrary();
const LIMITS = Object.freeze({ inputBytes: 65536, reportBytes: 4096 });

/** Reject missing/extra fields and non-object reports before retaining diagnostic metadata. */
function hasKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** Standalone Linux metadata reader. Only directory descriptors, lstat and bounded link-text reads are used.
 * First-pass guard precedence mirrors the pinned scanner until its first link rejection. Accounting then
 * continues independently; it does not weaken the scanner or prove any earlier execution's first failure.
 */
function metadataLibrary() {
  const posix = require('node:path').posix;
  const { TextDecoder } = require('node:util');
  const scope = 'gate1_link_rejection_metadata_v1';
  const source = 'd85af7e33cc01d386ec71247b06da250c6b9f473';
  const output = `/evidence/${source}/app/.vercel/output`;
  const ancestors = ['/evidence', `/evidence/${source}`, `/evidence/${source}/app`, `/evidence/${source}/app/.vercel`, output];
  const limits = Object.freeze({ internalMs: 18000, entriesPerWalk: 50000, entryVisits: 100000,
    filesPerWalk: 25000, depth: 64, metadataCalls: 500000, pathBytes: 4096, nameBytes: 255,
    inventoryPathBytes: 8388608, linkBytes: 4096, totalLinkBytes: 32768,
    fileBytes: 67108864, inventoryFileBytes: 1073741824, linkCount: 65535 });
  const failures = ['input', 'deadline', 'entry_limit', 'file_limit', 'depth_limit', 'metadata_limit',
    'path_limit', 'path_budget', 'encoding', 'forbidden_file', 'path', 'file_type', 'file_size',
    'total_bytes', 'changed', 'device', 'directory_identity', 'unreadable', 'cleanup', 'metadata'];
  /** Keep all filesystem messages and private paths out of public error fields. */
  class MetadataError extends Error {
    /** Accept only a finite category. */
    constructor(code) { super(failures.includes(code) ? code : 'metadata'); this.code = this.message; }
  }
  /** Validate non-coerced bounded counts, including identity fields that must not lose precision. */
  function count(value, maximum) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum && !Object.is(value, -0); }
  /** Match the scanner's identity stamp; access time is intentionally excluded. */
  function stamp(stat) { return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':'); }
  /** Identify a physical inode privately; this value never enters a report. */
  function inode(stat) { return `${stat.dev}:${stat.ino}`; }
  /** Refuse credential/configuration names before metadata traversal, matching scanner precedence. */
  function forbidden(name) { return /^(?:\.env(?:\..*)?|\.git|\.aws|\.codex|\.ssh|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?)$/i.test(name); }
  /** Initialize exact, finite public fields; partial accounting never has a completed count. */
  function base(approval) {
    return { schemaVersion: 1, scope, approval, outcome: 'inconclusive', reason: null,
      rejection: null, observedLinkCount: null, matchingNames: null, accounting: 'not_applicable',
      inventoryStable: false, historicalFirstFailureIdentified: false, walkOrder: 'breadth_first_native',
      counters: { entryVisits: 0, walksCompleted: 0, directoriesOpened: 0, metadataCalls: 0,
        linkTexts: 0, linkBytes: 0, fileContentBytes: 0, comparisonReads: 0 },
      artifactPrivacy: 'unqualified', gate1Status: 'open' };
  }
  /** Observe one fixed output with a shared deadline and counters. The IO seam is synthetic-test-only. */
  function inspect(approval, io = require('node:fs'), now = () => require('node:perf_hooks').performance.now()) {
    const report = base(approval), started = now(), fixedChain = [];
    let device, selected, rootNode, firstInventory;
    const flags = io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK;
    /** Reserve room for releasing at most 70 owned directory descriptors after any cap is reached. */
    function tick(operation = false) {
      if (now() - started >= limits.internalMs) throw new MetadataError('deadline');
      if (operation && report.counters.metadataCalls >= limits.metadataCalls - 512) throw new MetadataError('metadata_limit');
      if (operation) report.counters.metadataCalls++;
    }
    /** Count every ordinary metadata operation; no regular-file content method is exposed here. */
    function call(method, ...args) {
      tick(true);
      return method === 'readDirectory' ? args[0].readSync() : io[method](...args);
    }
    /** Finish descriptor verification under reserved metadata capacity even after the deadline. */
    function cleanupCall(method, ...args) {
      if (report.counters.metadataCalls >= limits.metadataCalls) throw new MetadataError('metadata_limit');
      report.counters.metadataCalls++; return io[method](...args);
    }
    /** Strict byte decoding avoids identifying two different raw directory entries as one name. */
    function text(bytes, maximum) {
      if (!Buffer.isBuffer(bytes) || bytes.length > maximum) throw new MetadataError('path_limit');
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new MetadataError('encoding'); }
    }
    /** Validate only metadata; inode/link-count precision is required for meaningful accounting. */
    function validateStat(stat) {
      if (!['dev', 'ino', 'mode', 'size'].every(key => count(stat[key], Number.MAX_SAFE_INTEGER)) ||
          !stat.ino || !count(stat.nlink, limits.linkCount) ||
          !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.ctimeMs)) throw new MetadataError('metadata');
    }
    /** Anchor children to directory handles without following artifact links or arbitrary target paths. */
    function child(node, name) { return `/proc/self/fd/${node.fd}/${name}`; }
    /** Acquire an ordinary directory and bind its descriptor to the preceding lstat identity. */
    function openDirectory(anchor, relative, stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MetadataError('changed');
      const fd = call('openSync', anchor, flags);
      try {
        if (stamp(stat) !== stamp(call('fstatSync', fd))) throw new MetadataError('changed');
        report.counters.directoriesOpened++;
        return { anchor, relative, stat, fd };
      } catch (error) { io.closeSync(fd); throw error; }
    }
    /** Check both name and descriptor identity before release; all owned descriptors are always closed. */
    function closeDirectory(node) {
      try {
        if (stamp(node.stat) !== stamp(cleanupCall('fstatSync', node.fd)) ||
            stamp(node.stat) !== stamp(cleanupCall('lstatSync', node.anchor))) throw new MetadataError('changed');
      } finally { io.closeSync(node.fd); }
    }
    /** Release a chain in reverse order, preserving any cleanup failure without exposing raw errors. */
    function closeChain(chain) {
      let failed = false;
      while (chain.length) { try { closeDirectory(chain.pop()); } catch { failed = true; } }
      if (failed) throw new MetadataError('cleanup');
    }
    /** Reopen only inventoried ordinary directory components; queued paths do not retain unbounded handles. */
    function acquire(relative, inventory) {
      const owned = []; let node = rootNode, current = '';
      try {
        for (const part of relative.split('/').filter(Boolean)) {
          current = current ? `${current}/${part}` : part;
          const expected = inventory.get(current), anchor = child(node, part), stat = call('lstatSync', anchor);
          validateStat(stat);
          if (!expected || expected.kind !== 'directory' || stamp(stat) !== expected.stamp) throw new MetadataError('changed');
          node = openDirectory(anchor, current, stat); owned.push(node);
        }
        return { node, owned };
      } catch (error) { closeChain(owned); throw error; }
    }
    /** Mirror initial scanner link-text checks; text is never resolved, published, or retained outside memory. */
    function inspectLink(anchor, stat) {
      if (stat.size > limits.linkBytes) throw new MetadataError('file_size');
      const bytes = call('readlinkSync', anchor, { encoding: 'buffer' });
      try {
        if (!Buffer.isBuffer(bytes) || bytes.length > limits.linkBytes) throw new MetadataError('file_size');
        if (report.counters.linkBytes + bytes.length > limits.totalLinkBytes) throw new MetadataError('total_bytes');
        report.counters.linkTexts++; report.counters.linkBytes += bytes.length;
        text(bytes, limits.linkBytes);
        if (stamp(stat) !== stamp(call('lstatSync', anchor))) throw new MetadataError('changed');
      } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
    }
    /** Inventory in scanner breadth-first/native order. After selection, count physical names only;
     * directory aliases are not traversed, and duplicate directory identities cannot inflate the count.
     */
    function walk(reference) {
      const inventory = new Map(), directories = new Set([inode(rootNode.stat)]);
      const queue = [{ relative: '', depth: 0 }]; let files = 0, fileBytes = 0, pathBytes = 0, matches = 0;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        tick(); const item = queue[cursor];
        if (item.depth > limits.depth) throw new MetadataError('depth_limit');
        const acquired = acquire(item.relative, inventory);
        try {
          const iterator = call('opendirSync', `/proc/self/fd/${acquired.node.fd}`, { encoding: 'buffer', bufferSize: 32 });
          try {
            while (true) {
              const entry = call('readDirectory', iterator);
              if (entry === null) break;
              if (inventory.size >= limits.entriesPerWalk || report.counters.entryVisits >= limits.entryVisits) throw new MetadataError('entry_limit');
              report.counters.entryVisits++;
              const name = text(entry.name, limits.nameBytes);
              if (forbidden(name)) throw new MetadataError('forbidden_file');
              if (!name || name === '.' || name === '..' || /[\\/:]/.test(name) ||
                  [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new MetadataError('path');
              const relative = item.relative ? `${item.relative}/${name}` : name;
              if (Buffer.byteLength(`${output}/${relative}`) > limits.pathBytes) throw new MetadataError('path_limit');
              pathBytes += Buffer.byteLength(relative);
              if (pathBytes > limits.inventoryPathBytes) throw new MetadataError('path_budget');
              if (inventory.has(relative)) throw new MetadataError('metadata');
              const anchor = child(acquired.node, name), stat = call('lstatSync', anchor);
              validateStat(stat);
              if (stat.dev !== device) throw new MetadataError('device');
              let kind;
              if (stat.isSymbolicLink()) {
                kind = 'symlink';
                if (!reference && !selected) inspectLink(anchor, stat);
              } else if (stat.isFile()) {
                kind = 'file';
                if (!reference && !selected && stat.nlink !== 1) {
                  selected = { relative, stat, stamp: stamp(stat), inode: inode(stat) };
                  report.rejection = 'file_link_count'; report.observedLinkCount = stat.nlink; report.accounting = 'inconclusive';
                  if (!stat.nlink) throw new MetadataError('changed');
                }
                if (++files > limits.filesPerWalk) throw new MetadataError('file_limit');
                if (!selected) {
                  if (stat.size > limits.fileBytes) throw new MetadataError('file_size');
                  fileBytes += stat.size;
                  if (fileBytes > limits.inventoryFileBytes) throw new MetadataError('total_bytes');
                }
                if (selected && inode(stat) === selected.inode) {
                  if (stamp(stat) !== selected.stamp) throw new MetadataError('changed');
                  matches++;
                }
              } else if (stat.isDirectory()) {
                kind = 'directory';
                if (directories.has(inode(stat))) throw new MetadataError('directory_identity');
                directories.add(inode(stat)); queue.push({ relative, depth: item.depth + 1 });
              } else throw new MetadataError('file_type');
              const record = { kind, stamp: stamp(stat), inode: inode(stat) };
              if (reference) {
                const expected = reference.get(relative);
                if (!expected || expected.kind !== kind || expected.stamp !== record.stamp) throw new MetadataError('changed');
              }
              inventory.set(relative, record);
            }
          } finally { iterator.closeSync(); }
        } finally { closeChain(acquired.owned); }
      }
      if (reference && reference.size !== inventory.size) throw new MetadataError('changed');
      if (stamp(rootNode.stat) !== stamp(call('fstatSync', rootNode.fd))) throw new MetadataError('changed');
      report.counters.walksCompleted++;
      return { inventory, matches };
    }
    try {
      if (!/^[a-f0-9]{64}$/.test(approval || '') || !io.constants.O_DIRECTORY || !io.constants.O_NOFOLLOW || !io.constants.O_NONBLOCK) throw new MetadataError('input');
      for (const logical of ancestors) {
        const anchor = fixedChain.length ? child(fixedChain[fixedChain.length - 1], posix.basename(logical)) : logical;
        const stat = call('lstatSync', anchor); validateStat(stat);
        if (stat.isSymbolicLink()) {
          if (stamp(stat) !== stamp(call('lstatSync', anchor))) throw new MetadataError('changed');
          report.rejection = 'ancestor_symlink'; report.outcome = 'diagnosed';
          break;
        }
        if (!stat.isDirectory()) throw new MetadataError('path');
        if (device === undefined) device = stat.dev;
        if (stat.dev !== device) throw new MetadataError('device');
        fixedChain.push(openDirectory(anchor, '', stat));
      }
      if (!report.rejection) {
        rootNode = fixedChain[fixedChain.length - 1];
        const first = walk(); firstInventory = first.inventory;
        if (!selected) report.outcome = 'not_reproduced';
        else {
          // Count names encountered before selection as well as after it; each physical name occurs once.
          const matches = [...firstInventory.values()].filter(v => v.kind === 'file' && v.inode === selected.inode);
          if (matches.some(v => v.stamp !== selected.stamp) || matches.length > selected.stat.nlink) throw new MetadataError('changed');
          const second = walk(firstInventory);
          if (second.matches !== matches.length || !matches.length) throw new MetadataError('changed');
          report.inventoryStable = true; report.matchingNames = matches.length;
          report.accounting = matches.length === selected.stat.nlink ? 'all_names_accounted_for_inside_output' : 'not_all_names_accounted_for_inside_output';
          report.outcome = 'diagnosed';
        }
      }
      tick();
    } catch (error) {
      report.outcome = 'inconclusive'; report.reason = error instanceof MetadataError ? error.code : 'unreadable';
    } finally {
      try {
        closeChain(fixedChain);
        if (now() - started >= limits.internalMs) { report.outcome = 'inconclusive'; report.reason = 'deadline'; }
      }
      catch { report.outcome = 'inconclusive'; report.reason = 'cleanup'; }
      if (report.outcome === 'inconclusive') {
        report.inventoryStable = false; report.matchingNames = null;
        report.accounting = report.rejection === 'file_link_count' ? 'inconclusive' : 'not_applicable';
      }
    }
    return report;
  }
  return { scope, source, output, ancestors, limits, failures, count, stamp, base, inspect };
}
const lib = metadataLibrary();

/** Validate every report field independently on the host; no paths, inodes or arbitrary diagnostics pass. */
function validateReport(bytes, approval) {
  const v = parser.parse(bytes, LIMITS.reportBytes), empty = lib.base(approval), c = v.counters;
  if (!hasKeys(v, Object.keys(empty)) || !hasKeys(c, Object.keys(empty.counters)) ||
      ['schemaVersion', 'scope', 'approval', 'walkOrder', 'historicalFirstFailureIdentified', 'artifactPrivacy', 'gate1Status'].some(k => v[k] !== empty[k]) ||
      !['diagnosed', 'inconclusive', 'not_reproduced'].includes(v.outcome) ||
      ![null, ...lib.failures].includes(v.reason) || ![null, 'ancestor_symlink', 'file_link_count'].includes(v.rejection) ||
      !['not_applicable', 'inconclusive', 'all_names_accounted_for_inside_output', 'not_all_names_accounted_for_inside_output'].includes(v.accounting) ||
      typeof v.inventoryStable !== 'boolean') throw Error('report');
  const maxima = { entryVisits: 100000, walksCompleted: 2, directoriesOpened: 500000, metadataCalls: 500000,
    linkTexts: 50000, linkBytes: 32768, fileContentBytes: 0, comparisonReads: 0 };
  if (Object.entries(maxima).some(([k, max]) => !lib.count(c[k], max)) ||
      c.directoriesOpened > c.metadataCalls || c.linkTexts > c.entryVisits || c.linkTexts > c.metadataCalls ||
      (v.outcome === 'inconclusive') !== (v.reason !== null)) throw Error('report');
  if (v.rejection === 'file_link_count') {
    if (!lib.count(v.observedLinkCount, lib.limits.linkCount) || v.observedLinkCount === 1 || !c.entryVisits) throw Error('report');
    if (v.outcome === 'diagnosed') {
      if (!v.inventoryStable || c.walksCompleted !== 2 || !lib.count(v.matchingNames, 25000) || !v.matchingNames ||
          v.matchingNames > v.observedLinkCount || c.entryVisits < 2 * v.matchingNames ||
          v.accounting !== (v.matchingNames === v.observedLinkCount ? 'all_names_accounted_for_inside_output' : 'not_all_names_accounted_for_inside_output')) throw Error('report');
    } else if (v.outcome !== 'inconclusive' || v.accounting !== 'inconclusive' || v.inventoryStable || v.matchingNames !== null) throw Error('report');
  } else if (v.observedLinkCount !== null || v.matchingNames !== null || v.inventoryStable || v.accounting !== 'not_applicable' ||
      v.rejection === 'ancestor_symlink' && (c.entryVisits || c.walksCompleted || v.outcome === 'not_reproduced') ||
      v.rejection === null && v.outcome === 'diagnosed' || v.outcome === 'not_reproduced' && c.walksCompleted !== 1) throw Error('report');
  return v;
}

/** Serialize built-in-only code: no scanner execution, application import, comparison or content read. */
function readerInput(approval) {
  if (!/^[a-f0-9]{64}$/.test(approval || '')) throw Error('approval');
  const bytes = Buffer.from(`'use strict';\nconst lib=(${metadataLibrary.toString()})();\n` +
    `const result=lib.inspect(${JSON.stringify(approval)});const text=JSON.stringify(result);\n` +
    `if(Buffer.byteLength(text)>4095)process.exitCode=1;else process.stdout.write(text+'\\n');\n`);
  if (bytes.length > LIMITS.inputBytes) throw Error('input');
  return bytes;
}

if (require.main === module) {
  process.stderr.write('Metadata library only. Use a separately reviewed execution adapter.\n');
  process.exitCode = 1;
}
module.exports = { LIMITS, metadataLibrary, lib, validateReport, readerInput };
