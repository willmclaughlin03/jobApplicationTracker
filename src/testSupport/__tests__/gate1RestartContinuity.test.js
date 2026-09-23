/** Offline supervisor contracts plus a real OS child with a network-free fetch preload. */
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LIMITS, LIVE_FLAGS, ROOT, APP_FILES, HARNESS_FILES, collectAttribution, freezeChildEnvironment, createPeer,
  runTrial, runCli } = require('../../../scripts/gate1-restart-continuity.js');
const { RestartError, failureCode } = require('../../../scripts/gate1-restart-transport.js');

const DIGEST = 'a'.repeat(64);
const ATTRIBUTION = { digest: DIGEST, gitSha: 'b'.repeat(40) };

/** Mutates only reads of one public attribution file via transform; no files are written. */
function mockAttributionFile(filename, transform) {
  const read = fs.readFileSync;
  return jest.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => {
    const value = read(name, ...args);
    return name === filename ? transform(value) : value;
  });
}

/** Supplies bounded Git metadata for live preflight tests without staging files or launching children. */
function mockAttributionGit({ tracked = true, status = '', revision = ATTRIBUTION.gitSha } = {}) {
  return jest.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
    expect(command).toBe('git');
    if (args[0] === 'ls-files' && tracked) return HARNESS_FILES.join('\n');
    if (args[0] === 'status') return status;
    if (args[0] === 'rev-parse') return revision;
    throw new Error('private Git failure details');
  });
}

describe('GATE-1 reviewed source attribution', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('attributes the reviewed observer/redaction baseline without claiming historical hosted correspondence', () => {
    const attribution = collectAttribution();
    expect(attribution).toMatchObject({
      appBase: 'eebe47f091aa1f522a8e18f7b2c916dc5e1de677',
      sdkVersion: '1.36.2', execution: 'native_source_modules',
      hostedReference: { gitSha: 'ba8c398c5d0af2dba9c75305397b774f946b6b1e' },
      hostedCorrespondence: 'not_verified',
    });
    expect(attribution.gitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(Object.keys(attribution.files)).toEqual([...APP_FILES, ...HARNESS_FILES]);
    expect(attribution.files['src/server/lib/temporarySessionCeiling.js']).toBe(createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'src/server/lib/temporarySessionCeiling.js'))).digest('hex'));
    expect(attribution.digest).toBe(createHash('sha256').update(JSON.stringify(attribution.files)).digest('hex'));
  });

  it.each(APP_FILES)('rejects changed pinned bytes in %s before any live child can start', async (name) => {
    mockAttributionFile(path.join(ROOT, name), (value) => `${value}\nchanged-source`);
    const spawn = jest.spyOn(childProcess, 'fork');
    const expected = expect.objectContaining({ code: 'attribution',
      diagnostic: { check: 'source_hash', file: name }, message: `attribution: source_hash (${name})` });
    expect(() => collectAttribution()).toThrow(expected);
    await expect(runCli(LIVE_FLAGS, { GATE1_RESTART_LIVE_ALLOWED: '1' })).rejects.toThrow(expected);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['nodejs.js', 'nodejs.mjs'])('rejects a changed SDK implementation in %s', (name) => {
    const sdkDirectory = path.dirname(require.resolve('@upstash/redis'));
    mockAttributionFile(path.join(sdkDirectory, name), (value) => Buffer.concat([value, Buffer.from('changed-sdk')]));
    expect(() => collectAttribution()).toThrow(expect.objectContaining({ code: 'attribution',
      diagnostic: { check: 'sdk_hash', file: name } }));
  });

  it.each(['\n', '\r\n'])('accepts the reviewed source with %j line endings', (ending) => {
    mockAttributionFile(path.join(ROOT, 'src/server/lib/temporarySessionCeiling.js'), (value) => {
      const source = value.toString().replace(/\r\n/g, '\n').replace(/\n/g, ending);
      return Buffer.isBuffer(value) ? Buffer.from(source) : source;
    });
    expect(collectAttribution().digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unsupported runtimes with a bounded diagnostic', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'version');
    Object.defineProperty(process, 'version', { ...descriptor, value: 'v20.0.0' });
    try {
      expect(() => collectAttribution()).toThrow(expect.objectContaining({ code: 'attribution',
        diagnostic: { check: 'runtime' } }));
    } finally { Object.defineProperty(process, 'version', descriptor); }
  });

  it('does not retain raw filesystem errors in attribution failures', () => {
    mockAttributionFile(path.join(ROOT, APP_FILES[0]), () => { throw new Error('private filesystem details'); });
    let failure;
    try { collectAttribution(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RestartError);
    expect(failureCode(failure)).toBe('attribution');
    expect(failure.diagnostic).toEqual({ check: 'source_hash', file: APP_FILES[0] });
    expect(`${failure.stack} ${JSON.stringify(failure)}`).not.toContain('private filesystem details');
    expect(failure.cause).toBeUndefined();
  });

  it('reports failed Git lookups without retaining command output', () => {
    jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('private Git details'); });
    expect(() => collectAttribution()).toThrow(expect.objectContaining({ code: 'attribution',
      message: 'attribution: git_revision', diagnostic: { check: 'git_revision' } }));
  });

  it('rejects malformed revision output without echoing it', () => {
    mockAttributionGit({ revision: 'private malformed Git output' });
    expect(() => collectAttribution()).toThrow(expect.objectContaining({ code: 'attribution',
      message: 'attribution: git_revision', diagnostic: { check: 'git_revision' } }));
  });

  it.each([
    [{ tracked: false }, 'tracked_harness'],
    [{ status: ' M scripts/gate1-restart-worker.mjs' }, 'clean_tree'],
  ])('keeps live execution blocked for Git state %j', async (state, check) => {
    mockAttributionGit(state);
    const spawn = jest.spyOn(childProcess, 'fork');
    await expect(runCli(LIVE_FLAGS, { GATE1_RESTART_LIVE_ALLOWED: '1' })).rejects.toThrow(
      expect.objectContaining({ code: 'attribution', diagnostic: { check } }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires tracked harness files and a clean tree when requested', () => {
    const git = mockAttributionGit();
    expect(collectAttribution({ requireClean: true }).gitSha).toBe(ATTRIBUTION.gitSha);
    expect(git.mock.calls.map(([, args]) => args)).toEqual([
      ['ls-files', '--error-unmatch', '--', ...HARNESS_FILES],
      ['status', '--porcelain', '--', ...APP_FILES, ...HARNESS_FILES],
      ['rev-parse', 'HEAD'],
    ]);
  });
});

/** Builds a deterministic process/clock model; no Redis or application HTTP calls occur. */
function fixture(options = {}) {
  let elapsed = 0;
  let shared = 0;
  let aExited = false;
  const calls = [];
  const peers = [];
  const controller = new AbortController();
  /** Represents one externally supervised process while preserving shared backend state. */
  function launch(label) {
    calls.push(`start${label}`);
    if (label === 'B') {
      expect(aExited).toBe(true);
      if (options.expireDuringStartup) elapsed += 61000;
      if (options.resetOnRestart) shared = 0;
    }
    let sequence = 0;
    let decisionCount = 0;
    let timeReads = 0;
    let fetches = 0;
    let dead = false;
    /** Produces fixed, identifier-free transport counters for this synthetic child. */
    function stats() {
      return { fetchAttempts: fetches, forwarded: fetches, commands: decisionCount + timeReads,
        evalsha: decisionCount, eval: 0, time: timeReads, noscript: 0,
        retriesBlocked: 0, active: 0, failure: null };
    }
    const peer = {
      label,
      ready: async () => ({ type: 'ready', pid: label === 'A' ? 101 : 102,
        runtime: 'v22.18.0', digest: options.wrongDigest ? 'c'.repeat(64) : DIGEST }),
      assertHealthy: () => { if (options.unexpectedExit && shared >= 4) throw new RestartError('process_exit'); },
      request: async (kind, ids) => {
        expect(dead).toBe(false);
        elapsed += 20;
        sequence += 1;
        fetches += 1;
        if (kind === 'clock') {
          timeReads += 1;
          return { type: 'reply', seq: sequence, kind, redisTime: [label === 'A' ? 1000
            : options.redisClockJump ? 1061 : options.redisClockBackwards ? 999 : 1010, 0], stats: stats() };
        }
        decisionCount += ids.length;
        if (options.lostReply && ids.includes(201)) throw new RestartError('transport_uncertain');
        if (options.retry && ids.includes(201)) throw new RestartError('retry_detected');
        if (options.cancel && ids.includes(201)) controller.abort();
        const items = ids.map((id) => {
          const allowed = shared < 400;
          if (allowed) shared += 1;
          return { id: options.duplicateId && id === 2 ? 1 : id, allowed,
            statusCode: allowed ? 200 : 429, retryAfterSeconds: allowed ? null : 50 };
        });
        return { type: 'reply', seq: sequence, kind, items, stats: stats() };
      },
      terminate: async () => {
        calls.push(`exit${label}`);
        dead = true;
        if (options.cleanupFails) throw new RestartError('cleanup');
        if (options.missingExit && label === 'A') return { exitObserved: false, closed: true };
        if (label === 'A') aExited = true;
        return { pid: label === 'A' ? 101 : 102, code: null, signal: 'SIGKILL', exitObserved: true, closed: true };
      },
    };
    peers.push(peer);
    return peer;
  }
  /** Advances simulated time; a full quiet period lets the synthetic window expire naturally. */
  async function wait(ms) {
    elapsed += options.shortQuiet ? ms - 1 : ms;
    if (!options.shortQuiet) shared = 0;
  }
  return { launch, wait, now: () => elapsed, attribution: ATTRIBUTION,
    signal: controller.signal, calls, peers };
}

/** Provides fake process metadata/events for strict IPC and exit-event unit checks. */
function fakeChildFactory({ duplicate = false, wrongPid = false } = {}) {
  const child = new EventEmitter();
  child.pid = 123;
  child.send = jest.fn();
  child.kill = jest.fn(() => {
    queueMicrotask(() => { child.emit('exit', null, 'SIGKILL'); child.emit('close'); });
    return true;
  });
  /** Delivers readiness only after createPeer has attached its listeners. */
  function spawnChild() {
    queueMicrotask(() => {
      const message = { type: 'ready', pid: wrongPid ? 124 : 123, runtime: 'v22.18.0', digest: DIGEST };
      child.emit('message', message);
      if (duplicate) child.emit('message', message);
    });
    return child;
  }
  return { child, spawnChild };
}

describe('GATE-1 controlled restart supervisor', () => {
  it('retains A exit before B start and validates the 400/401 boundary plus recovery', async () => {
    const f = fixture();
    const report = await runTrial(f);
    expect(report).toMatchObject({ result: 'completed', mode: 'offline', gate1Status: 'open',
      restartEvidence: 'not_executed', hostedEvidence: 'not_executed', attempted: 402,
      acknowledged: 402, validated: 402, unvalidatedAttempts: 0, cleanup: 'confirmed', failure: null });
    expect(f.calls).toEqual(['startA', 'exitA', 'startB', 'exitB']);
    expect(report.receipts.filter((item) => item.statusCode === 429)).toEqual([
      { actor: 'B', phase: 'reject401', id: 401, allowed: false, statusCode: 429,
        retryAfterSeconds: 50, validated: true },
    ]);
    expect(report.receipts.filter((item) => item.actor === 'A')).toHaveLength(200);
    expect(report.quietPeriodsMs).toEqual([64000, 64000]);
    expect(report.boundaryDurationMs).toBeLessThan(45000);
    expect(report.redisBoundaryMs).toBe(10000);
  });

  it('cannot pass when B gets a fresh process-local allowance', async () => {
    const report = await runTrial(fixture({ resetOnRestart: true }));
    expect(report).toMatchObject({ result: 'stopped', failure: 'decision', stoppedPhase: 'reject401' });
  });

  it.each([
    ['lost reply', { lostReply: true }, 'transport_uncertain'],
    ['retry', { retry: true }, 'retry_detected'],
    ['duplicate decision ID', { duplicateId: true }, 'protocol'],
    ['expired original consumption', { expireDuringStartup: true }, 'deadline'],
    ['Redis clock jump', { redisClockJump: true }, 'clock'],
    ['Redis clock reversal', { redisClockBackwards: true }, 'clock'],
    ['short quiet period', { shortQuiet: true }, 'clock'],
    ['wrong code digest', { wrongDigest: true }, 'attribution'],
    ['unexpected child exit', { unexpectedExit: true }, 'process_exit'],
    ['operator cancellation', { cancel: true }, 'deadline'],
    ['unconfirmed cleanup', { cleanupFails: true }, 'cleanup'],
  ])('does not pass after %s', async (_name, options, failure) => {
    const report = await runTrial(fixture(options));
    expect(report).toMatchObject({ result: 'stopped', failure, restartEvidence: 'not_qualified' });
    expect(report.attempted).toBeLessThanOrEqual(402);
  });

  it('keeps uncertain attempts separate from acknowledged counts and starts no recovery', async () => {
    const report = await runTrial(fixture({ lostReply: true }));
    expect(report).toMatchObject({ attempted: 204, acknowledged: 200, validated: 200, unvalidatedAttempts: 4 });
    expect(report.quietPeriodsMs).toHaveLength(1);
  });

  it('never starts B without independent confirmation of A exit', async () => {
    const f = fixture({ missingExit: true });
    const report = await runTrial(f);
    expect(report.result).toBe('stopped');
    expect(f.calls).not.toContain('startB');
  });

  it('rejects source changes during the trial', async () => {
    const report = await runTrial({ ...fixture(), checkAttribution: () => ({ digest: 'd'.repeat(64) }) });
    expect(report).toMatchObject({ result: 'stopped', failure: 'attribution' });
  });

  it('excludes preload, hosted and remote logger credentials from child environments', () => {
    const env = { TEMPORARY_SESSION_CEILING_LOCAL_HMAC_SECRET: 'synthetic-hmac',
      TEMPORARY_SESSION_CEILING_LOCAL_REDIS_SECRET: 'synthetic-redis', NODE_OPTIONS: '--unsafe',
      AXIOM_TOKEN: 'private', VERCEL: '1', OTHER_SECRET: 'private', SystemRoot: 'C:/Windows' };
    const child = freezeChildEnvironment(env, '2001:db8::1');
    expect(Object.isFrozen(child)).toBe(true);
    expect(child).toMatchObject({ NODE_ENV: 'test', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'local' });
    for (const name of ['NODE_OPTIONS', 'AXIOM_TOKEN', 'VERCEL', 'OTHER_SECRET']) expect(child[name]).toBeUndefined();
    expect(() => freezeChildEnvironment({}, '2001:db8::1')).toThrow('configuration');
  });

  it('has no default live execution and rejects partial authorizations', async () => {
    const report = await runCli([], {});
    expect(report).toMatchObject({ mode: 'prepare', restartEvidence: 'not_executed', gate1Status: 'open' });
    await expect(runCli(['--live'], {})).rejects.toThrow('configuration');
    await expect(runCli(LIVE_FLAGS, { GATE1_RESTART_LIVE_ALLOWED: '0' })).rejects.toThrow('configuration');
  });

  it.each([{ duplicate: true }, { wrongPid: true }])('rejects invalid readiness %j', async (options) => {
    const f = fakeChildFactory(options);
    const peer = createPeer('A', {}, DIGEST, undefined, f);
    try {
      try { await peer.ready(); } catch { /* Health assertion also covers already-resolved readiness. */ }
      expect(() => peer.assertHealthy()).toThrow();
    } finally { await peer.terminate(); }
  });

  it('rejects unsolicited acknowledgements and raw provider data', async () => {
    const f = fakeChildFactory();
    const peer = createPeer('A', {}, DIGEST, undefined, f);
    try {
      await peer.ready();
      f.child.emit('message', { type: 'reply', seq: 1, kind: 'decisions', private: 'provider-secret' });
      expect(() => peer.assertHealthy()).toThrow('protocol');
    } finally { await peer.terminate(); }
  });

  it('requires an exit event even when kill returns true', async () => {
    jest.useFakeTimers();
    const f = fakeChildFactory();
    f.child.kill.mockImplementation(() => true);
    const peer = createPeer('A', {}, DIGEST, undefined, f);
    try {
      await jest.advanceTimersByTimeAsync(0);
      await peer.ready();
      const pending = expect(peer.terminate()).rejects.toThrow('cleanup');
      await jest.advanceTimersByTimeAsync(LIMITS.exitMs);
      await pending;
    } finally { jest.useRealTimers(); }
  });

  it('stops on a missing acknowledgement and confirms cleanup', async () => {
    jest.useFakeTimers();
    const f = fakeChildFactory();
    const peer = createPeer('A', {}, DIGEST, undefined, f);
    try {
      await jest.advanceTimersByTimeAsync(0);
      await peer.ready();
      const pending = expect(peer.request('clock')).rejects.toThrow('deadline');
      await jest.advanceTimersByTimeAsync(LIMITS.commandMs);
      await pending;
      const cleanup = peer.terminate();
      await jest.advanceTimersByTimeAsync(0);
      expect(await cleanup).toMatchObject({ exitObserved: true });
    } finally { jest.useRealTimers(); }
  });

  it('handles a synchronous IPC failure without an unhandled rejected promise', async () => {
    const f = fakeChildFactory();
    f.child.send.mockImplementation(() => { throw new Error('private IPC details'); });
    const peer = createPeer('A', {}, DIGEST, undefined, f);
    try {
      await peer.ready();
      await expect(peer.request('clock')).rejects.toThrow('protocol');
    } finally { await peer.terminate(); }
  });

  it('retains a sanitized failure-time transport snapshot independently of child exit', async () => {
    const f = fakeChildFactory();
    const peer = createPeer('A', {}, DIGEST, undefined, f);
    const stats = { fetchAttempts: 1, forwarded: 1, commands: 4, evalsha: 4, eval: 0,
      time: 0, noscript: 0, retriesBlocked: 0, active: 1, failure: 'transport_uncertain' };
    try {
      await peer.ready();
      f.child.emit('message', { type: 'fatal', code: 'transport_uncertain', stats });
      expect(() => peer.assertHealthy()).toThrow('transport_uncertain');
      expect(peer.getStats()).toEqual(stats);
    } finally { await peer.terminate(); }
    expect(peer.getStats()).toEqual(stats);
  });

  it('imports the actual worker/limiter in a real child and confirms its OS exit offline', async () => {
    const attribution = collectAttribution();
    const env = freezeChildEnvironment({
      SystemRoot: process.env.SystemRoot,
      TEMPORARY_SESSION_CEILING_LOCAL_HMAC_SECRET: JSON.stringify({ schemaVersion: 1,
        active: { generation: 1, keyId: 'offline', key: Buffer.alloc(32, 7).toString('base64url') }, previous: null }),
      TEMPORARY_SESSION_CEILING_LOCAL_REDIS_SECRET: JSON.stringify({ schemaVersion: 1,
        url: 'https://synthetic.upstash.io', token: 'synthetic-token' }),
    }, '2001:db8::1234');
    // This native preload replaces fetch before any application import; it cannot send traffic.
    const preload = `globalThis.fetch = async function offlineFetch(_input, init) {
      const commands = JSON.parse(init.body);
      return new Response(JSON.stringify(commands.map(command => ({result:
        command[0] === 'time' ? [1000, 0] : [1, 0, 0]}))), {status: 200});
    };`;
    const peer = createPeer('A', env, attribution.digest, undefined, {
      spawnChild: (module, args, options) => fork(module, args, { ...options,
        execArgv: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] }),
    });
    try {
      const ready = await peer.ready();
      expect(ready.pid).not.toBe(process.pid);
      expect((await peer.request('clock')).redisTime).toEqual([1000, 0]);
      const reply = await peer.request('decisions', [1, 2, 3, 4]);
      expect(reply.items.every((item) => item.allowed && item.statusCode === 200)).toBe(true);
      expect(reply.stats).toMatchObject({ evalsha: 4, time: 1, retriesBlocked: 0, failure: null });
    } finally {
      expect(await peer.terminate()).toMatchObject({ exitObserved: true, closed: true });
    }
  }, 25000);
});
