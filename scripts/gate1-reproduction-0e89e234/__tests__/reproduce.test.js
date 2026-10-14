'use strict';

/** Synthetic-only regression tests: temporary public fixtures, bounded Node children, and mocked Docker. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const r = require('../reproduce');
const q = r.qualification();
const dictionary = { locations: { 'src/pages/index.js': 80, 'scripts/validate-build-env.js': 90 },
  modules: ['next', '@/lib/missing', './component'], literals: ['Supabase URL is required.'] };
const secret = 'synthetic-SECRET-private-0123456789-value';
const fixtureParent = path.resolve(__dirname, '../fixtures');

/** Construct a fixture inside this approved local helper directory, never inside historical evidence. */
function fixture(t) {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, 'case-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== fixtureParent || !path.basename(root).startsWith('case-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
/** Decode synthetic output through exactly the Linux allowlist, with no raw logger or output file. */
function extract(text, values = [secret]) { return r.extract(Buffer.from(text), 'stderr', dictionary, values); }
/** Supply a child environment without inheriting provider credentials or Node preload options. */
function childOptions(extra = {}) {
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(n => process.env[n]).map(n => [n, process.env[n]]));
  return { cwd: __dirname, env, dictionary, secrets: [secret], budget: { bytes: 0 }, timeoutMs: 5000, ...extra };
}
/** Build a small valid terminal to exercise independent host report validation. */
function terminal(stage = 'build', completed = false) {
  const steps = stage === 'build' ? ['postinstall', 'vercel_build'] : ['toolchain_install', 'application_install', 'ownership'];
  return { scope: r.SCOPE, sourceSha: r.SOURCE, approval: 'a'.repeat(64), stage, result: completed ? 'completed' : 'stopped',
    failingStep: completed ? null : steps.at(-1), versions: q.VERSIONS, failure: completed ? null : 'child', rawStreamsRetained: false, gate1Status: 'open',
    children: steps.map((step, i) => ({ step, reason: 'closed', exitCode: completed || i < steps.length - 1 ? 0 : 1, signal: null,
      sizes: { stdout: 0, stderr: 0 }, diagnostics: [] })) };
}

test('missing module retains the public reference and original file/line', () => {
  const found = extract("./src/pages/index.js:12:3\nModule not found: Can't resolve '@/lib/missing'");
  assert.equal(found.detail, '@/lib/missing'); assert.deepEqual(found.sourceLocation, { file: 'src/pages/index.js', line: 12, column: 3 });
  assert.equal(r.validDiagnostic(found, dictionary), true);
});
test('preflight retains names and exact observed command, never values', () => {
  const found = extract('> npm run build:preflight && next build\n> node scripts/validate-build-env.js\nMissing required build environment variables:\n- CSRF_SECRET\n- SUPABASE_SERVICE_ROLE_KEY');
  assert.equal(found.observedCommand, 'node scripts/validate-build-env.js');
  assert.equal(found.message, 'Missing required build environment variables: CSRF_SECRET, SUPABASE_SERVICE_ROLE_KEY');
});
test('unknown preflight fields reject the complete candidate', () => {
  assert.equal(extract('Missing required build environment variables:\n- CSRF_SECRET\n- ' + secret), null);
});
test('public source literal remains actionable', () => assert.equal(extract('Error: Supabase URL is required.').message, 'Supabase URL is required.'));
test('syntax token and following original stack location are allowed', () => {
  const found = extract("SyntaxError: Unexpected token '}'\n at /state/" + r.SOURCE + '/app/src/pages/index.js:44:8');
  assert.equal(found.message, 'Unexpected token }'); assert.equal(found.sourceLocation.line, 44);
});
test('system codes exclude URL credentials and raw suffix text', () => {
  const found = extract('npm error code ENOTCACHED\n' + secret);
  assert.deepEqual({ kind: found.kind, detail: found.detail }, { kind: 'system_code', detail: 'ENOTCACHED' });
  assert.equal(JSON.stringify(found).includes(secret), false);
});
test('ordinary Unicode banner does not erase a later safe diagnostic', () => {
  assert.equal(extract("▲ Next.js\nModule not found: Can't resolve 'next'").detail, 'next');
});
test('SGR styling is removed and arbitrary terminal control lines are dropped', () => {
  assert.equal(extract("\u001b[31mModule not found: Can't resolve 'next'\u001b[0m").detail, 'next');
  assert.equal(extract("\u001b[2JModule not found: Can't resolve 'next'"), null);
});
for (const input of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), encodeURIComponent(secret), secret.slice(0, 12)]) {
  test('unknown secret-derived module or error text cannot be retained: ' + input.length, () => {
    assert.equal(extract("Cannot find module '" + input + "'"), null);
    assert.equal(extract('Error: ' + input), null);
  });
}
test('known secret matching an otherwise public candidate stops reporting', () => {
  assert.throws(() => extract("Cannot find module 'next'", ['next']), /Reproduction stopped/);
});
test('generated, absolute foreign, traversal and invalid source lines are not exported', () => {
  for (const text of ['.next/server/a.js:1:1', '/home/owner/src/pages/index.js:1', '../src/pages/index.js:1', 'src/pages/index.js:9999', 'src/pages/index.js:1:0']) assert.equal(r.location(text, dictionary), null);
});
test('plain original source reference without line is valid', () => {
  assert.deepEqual(r.location('./src/pages/index.js', dictionary), { file: 'src/pages/index.js', line: null, column: null });
});
test('invalid UTF-8 and overlong diagnostic lines are rejected', () => {
  assert.throws(() => r.cleanLines(Buffer.from([255])));
  assert.throws(() => extract('x'.repeat(r.LIMITS.lineBytes + 1)));
});
test('first recognized message is selected; raw generic command errors remain discarded', () => {
  const found = extract("Error: Command exited with 1\nCannot find module 'next'\nError: Supabase URL is required.");
  assert.equal(found.kind, 'missing_module'); assert.equal(extract('Error: Command exited with 1'), null);
});
test('host rejects appended fields and forged diagnostic text', () => {
  const found = extract("Cannot find module 'next'");
  assert.equal(r.validDiagnostic({ ...found, raw: secret }, dictionary), false);
  assert.equal(r.validDiagnostic({ ...found, message: secret }, dictionary), false);
  assert.equal(r.validDiagnostic({ ...found, detail: secret }, dictionary), false);
});
test('stderr and stdout survive normal nonzero child exit only as safe diagnostics', async () => {
  const result = await r.capture(process.execPath, ['-e', `process.stdout.write("Cannot find module 'next'\\n");process.stderr.write('Error: Supabase URL is required.\\n');process.exitCode=1;`], childOptions());
  assert.equal(result.reason, 'closed'); assert.equal(result.exitCode, 1);
  assert.deepEqual(result.diagnostics.map(d => d.stream), ['stdout', 'stderr']);
  assert.equal(Object.hasOwn(result, 'raw'), false);
});
test('secret split across chunks and multiline output is not emitted', async () => {
  const script = `process.stderr.write("Cannot find module '${secret.slice(0, 12)}");setTimeout(()=>{process.stderr.write("${secret.slice(12)}'\\nCannot find module 'next'\\n");process.exitCode=1},20)`;
  const result = await r.capture(process.execPath, ['-e', script], childOptions());
  assert.equal(result.diagnostics[0].detail, 'next'); assert.equal(JSON.stringify(result).includes(secret), false);
});
test('both stream caps stop execution without promoting buffered diagnostics', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const result = await r.capture(process.execPath, ['-e', `process.${stream}.write("Cannot find module 'next'\\n"+'x'.repeat(512));setInterval(()=>{},1000)`], childOptions({ streamLimit: 64 }));
    assert.equal(result.reason, 'stream_limit'); assert.deepEqual(result.diagnostics, []);
  }
});
test('stage byte budget is shared across child processes', async () => {
  const budget = { bytes: 40 };
  const result = await r.capture(process.execPath, ['-e', "process.stdout.write('x'.repeat(32))"], childOptions({ budget, stageLimit: 64 }));
  assert.equal(result.reason, 'stream_limit');
});
test('deadline stops a stalled child without retaining partial diagnostics', async () => {
  const result = await r.capture(process.execPath, ['-e', "process.stderr.write(\"Cannot find module 'next'\\n\");setInterval(()=>{},1000)"], childOptions({ timeoutMs: 150 }));
  assert.equal(result.reason, 'deadline'); assert.deepEqual(result.diagnostics, []);
});
test('storage monitor failure stops child output', async () => {
  const result = await r.capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], childOptions({ poll() { throw new Error(secret); } }));
  assert.equal(result.reason, 'storage'); assert.equal(JSON.stringify(result).includes(secret), false);
});
test('spawn failure does not expose exception details', async () => {
  const result = await r.capture('not-used', [], childOptions({ spawn() { throw new Error(secret); } }));
  assert.equal(result.reason, 'spawn'); assert.deepEqual(result.diagnostics, []);
});
test('invalid UTF-8 on normal failure yields a safe suppression result', async () => {
  const result = await r.capture(process.execPath, ['-e', 'process.stderr.write(Buffer.from([255]));process.exitCode=1'], childOptions());
  assert.equal(result.reason, 'unsafe_output'); assert.deepEqual(result.diagnostics, []);
});
test('successful child output is discarded', async () => {
  const result = await r.capture(process.execPath, ['-e', "process.stderr.write(\"Cannot find module 'next'\\n\")"], childOptions());
  assert.equal(result.exitCode, 0); assert.deepEqual(result.diagnostics, []);
});
test('host validates a stopped report with an actionable diagnostic', () => {
  const value = terminal(); value.children[1].diagnostics.push(extract("Cannot find module 'next'"));
  assert.equal(r.validateReport(value, 'build', 'a'.repeat(64), dictionary, q), value);
});
for (const mutate of [v => { v.sourceSha = 'b'.repeat(40); }, v => { v.approval = 'b'.repeat(64); }, v => { v.raw = secret; },
  v => { v.children[0].exitCode = 1; }, v => { v.children[1].exitCode = 999; }, v => { v.children[1].raw = secret; },
  v => { v.children[1].reason = secret; }, v => { v.children[1].sizes.stdout = -1; }, v => { v.versions = { raw: secret }; }]) {
  test('host rejects malformed or contradictory attribution/status ' + mutate.toString().slice(7, 55), () => {
    const value = terminal(); mutate(value); assert.throws(() => r.validateReport(value, 'build', 'a'.repeat(64), dictionary, q));
  });
}
test('success requires complete command sequence and versions', () => {
  const value = terminal('prepare', true); value.children.pop();
  assert.throws(() => r.validateReport(value, 'prepare', 'a'.repeat(64), dictionary, q));
});
test('container arguments cannot mount the failed volume or enable network', () => {
  const args = r.containerArgs('build');
  assert.equal(args.includes('--network=none'), true); assert.equal(args.includes('--log-driver=none'), true);
  assert.equal(args.join(' ').includes('gate1-build-qualification-v1'), false);
  assert.equal(args.filter(a => a.includes('type=volume')).length, 2);
  assert.equal(args.includes(r.IMAGE), true); assert.equal(args.includes('/usr/bin/env'), true);
  assert.throws(() => r.containerArgs('inspect'));
});
test('child environment has fixed offline values and no inherited token', () => {
  const env = r.linuxEnvironment();
  assert.equal(env.npm_config_offline, 'true'); assert.equal(env.npm_config_logs_max, '0');
  assert.equal(Object.hasOwn(env, 'VERCEL_TOKEN'), false); assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
});
test('catalog uses matching public blobs and rejects altered source', t => {
  const root = fixture(t), source = "import thing from 'next'; throw new Error('Supabase URL is required.');\n";
  const lock = '{"packages":{}}'; fs.writeFileSync(path.join(root, 'app.js'), source); fs.writeFileSync(path.join(root, 'package-lock.json'), lock);
  const manifest = [['app.js', source], ['package-lock.json', lock]].map(([name, text]) => ({ name, oid: require('node:crypto').createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0` + text).digest('hex') }));
  const result = r.catalog(q, root, manifest, { packages: {} }); assert.equal(result.modules.includes('next'), true);
  fs.appendFileSync(path.join(root, 'app.js'), 'changed'); assert.throws(() => r.catalog(q, root, manifest, { packages: {} }));
});
test('cleanup rejects names and only removes the exact owned ID', async () => {
  const calls = [], cid = 'c'.repeat(64);
  const docker = async args => { calls.push(args); return Buffer.from(args[0] === 'inspect' ? JSON.stringify({ Running: false, ExitCode: 1, OOMKilled: false }) : ''); };
  assert.deepEqual(await r.cleanup(q, docker, cid), { exitCode: 1, oomKilled: false });
  assert.equal(calls.find(a => a[0] === 'rm')[2], cid);
  await assert.rejects(r.cleanup(q, docker, r.NAME));
});
test('unconfirmed running container blocks cleanup success', async () => {
  const docker = async args => Buffer.from(args[0] === 'inspect' ? JSON.stringify({ Running: true, ExitCode: 0, OOMKilled: false }) : '');
  await assert.rejects(r.cleanup(q, docker, 'c'.repeat(64)));
});

/** Build a fully mocked execution path with private temporary reservation/report files. */
function executionFixture(t, options = {}) {
  const registry = fixture(t), calls = [], cid = 'c'.repeat(64), digest = 'a'.repeat(64);
  const evidence = path.join(registry, 'original.reservation.json'); fs.writeFileSync(evidence, '{"consumed":true}');
  const contract = { preservedEvidence: { [evidence]: q.fileHash(evidence) } };
  const prepared = { digest, contract, dictionary, code: Buffer.from('// synthetic fixture, not executable\n') };
  let starts = 0;
  const docker = async (args, opts) => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') return Buffer.from(JSON.stringify([{ Name: r.VOLUME, Driver: 'local', Options: null, Labels: { 'gate1.scope': r.SCOPE } }]));
    if (args[0] === 'create') { if (options.createFails) throw new Error(secret); return Buffer.from(cid); }
    if (args[0] === 'inspect') return Buffer.from(JSON.stringify({ Running: Boolean(options.teardownFails), ExitCode: starts > 1 && !options.success ? 1 : 0, OOMKilled: false }));
    if (args[0] === 'start') {
      starts++; const stage = starts === 1 ? 'prepare' : 'build';
      const value = terminal(stage, starts === 1 || Boolean(options.success));
      if (stage === 'build' && !options.success) {
        value.children[1].diagnostics.push(extract("Cannot find module 'next'"));
        const error = Object.assign(new Error(secret), { code: 'child', exitCode: 1, signal: null });
        error.report = opts.parseFailureReport(Buffer.from(JSON.stringify(value))); throw error;
      }
      return Buffer.from(JSON.stringify(value));
    }
    return Buffer.from('');
  };
  return { registry, calls, evidence, digest, prepared,
    deps: { prepare: async () => prepared, review: contract, registry, docker, readiness: async () => {}, verifyContainer: async () => {} } };
}
test('wrong approval or phrase makes no Docker calls and no reservation', async t => {
  const f = executionFixture(t);
  await assert.rejects(r.execute(f.digest, 'wrong', f.deps)); assert.equal(f.calls.length, 0);
  await assert.rejects(r.execute('b'.repeat(64), r.PHRASE, f.deps)); assert.equal(fs.readdirSync(f.registry).length, 1);
});
test('one failed reproduction retains safe output, consumes approval and preserves original evidence', async t => {
  const f = executionFixture(t), before = fs.readFileSync(f.evidence);
  const result = await r.execute(f.digest, r.PHRASE, f.deps);
  assert.equal(result.result, 'stopped'); assert.equal(result.failure, 'stage');
  assert.equal(result.stages[1].terminal.children[1].diagnostics[0].detail, 'next');
  assert.equal(result.teardownUnconfirmed, false); assert.equal(result.persistenceFailure, false);
  assert.deepEqual(fs.readFileSync(f.evidence), before); assert.equal(fs.existsSync(path.join(f.registry, 'active.lock')), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const count = f.calls.length; await assert.rejects(r.execute(f.digest, r.PHRASE, f.deps));
  assert.equal(f.calls.length, count); assert.equal(f.calls.filter(a => a[0] === 'start').length, 2);
});
test('ambiguous create retains the shared lock and consumes the attempt without retry', async t => {
  const f = executionFixture(t, { createFails: true }); const result = await r.execute(f.digest, r.PHRASE, f.deps);
  assert.equal(result.teardownUnconfirmed, true); assert.equal(fs.existsSync(path.join(f.registry, 'active.lock')), true);
  assert.equal(f.calls.filter(a => a[0] === 'create').length, 1); assert.equal(f.calls.some(a => a[0] === 'rm'), false);
});
test('teardown uncertainty keeps the lock and prevents build continuation', async t => {
  const f = executionFixture(t, { teardownFails: true }); const result = await r.execute(f.digest, r.PHRASE, f.deps);
  assert.equal(result.teardownUnconfirmed, true); assert.equal(fs.existsSync(path.join(f.registry, 'active.lock')), true);
  assert.equal(f.calls.filter(a => a[0] === 'start').length, 1);
});
test('foreign lock stops before mutation and remains unchanged', async t => {
  const f = executionFixture(t); fs.writeFileSync(path.join(f.registry, 'active.lock'), 'foreign');
  await assert.rejects(r.execute(f.digest, r.PHRASE, f.deps)); assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.registry, 'active.lock'), 'utf8'), 'foreign');
});
test('mocked success remains GATE-1 open and performs no artifact inspection', async t => {
  const f = executionFixture(t, { success: true }); const result = await r.execute(f.digest, r.PHRASE, f.deps);
  assert.equal(result.result, 'completed'); assert.equal(result.gate1Status, 'open');
  assert.equal(f.calls.filter(a => a[0] === 'start').length, 2); assert.equal(fs.existsSync(path.join(f.registry, r.KEY + '.reservation.json')), true);
});
test('stdin execution dispatch rejects an invalid envelope before any package process', async () => {
  const bytes = fs.readFileSync(path.join(__dirname, '../reproduce.js'));
  await assert.rejects(q.supervise(process.execPath, ['-'], { cwd: path.resolve(__dirname, '..'), env: childOptions().env,
    input: Buffer.concat([Buffer.from('globalThis.__gate1Envelope={};\n'), bytes]) }), error => error.code === 'child' && error.exitCode === 1);
});
test('unknown extra report diagnostics and multiline injection cannot pass host validation', () => {
  const value = terminal(); const found = extract("Cannot find module 'next'");
  value.children[1].diagnostics = [{ ...found, detail: 'next\n' + secret }];
  assert.throws(() => r.validateReport(value, 'build', 'a'.repeat(64), dictionary, q));
});
test('late child output is ignored after a limit stop', async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const resultPromise = r.capture('mock', [], childOptions({ streamLimit: 2, spawn() { return child; } }));
  child.stderr.emit('data', Buffer.from('overflow')); child.stderr.emit('data', Buffer.from(secret)); child.emit('close', 1, null);
  const result = await resultPromise; assert.equal(result.reason, 'stream_limit'); assert.equal(result.sizes.stderr, 8);
});

/** Model Docker's public container configuration without executing any container. */
function containerState() {
  const args = r.containerArgs('build');
  return [{ Id: 'c'.repeat(64), Image: r.IMAGE, State: { Running: false },
    Config: { Entrypoint: ['/usr/bin/timeout'], Cmd: args.slice(args.indexOf(r.IMAGE) + 1) },
    Mounts: ['/state', '/opt/gate1/.tmp'].map(Destination => ({ Type: 'volume', Name: r.VOLUME, RW: true, Destination })),
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, LogConfig: { Type: 'none' }, RestartPolicy: { Name: 'no' },
      Memory: r.LIMITS.memoryBytes, MemorySwap: r.LIMITS.memoryBytes, NanoCpus: 4000000000, PidsLimit: 256,
      Privileged: false, Init: true, Binds: null, Devices: [], CapDrop: ['ALL'], CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETUID', 'SETGID'],
      SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=536870912,mode=1777' },
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }, { Name: 'core', Soft: 0, Hard: 0 }] } }];
}
test('created container controls are checked before start', async () => {
  await r.verifyContainer(q, async () => Buffer.from(JSON.stringify(containerState())), 'c'.repeat(64));
});
for (const mutate of [v => { v[0].HostConfig.NetworkMode = 'bridge'; }, v => { v[0].HostConfig.Memory = 0; },
  v => { v[0].Mounts[0].Name = 'gate1-build-qualification-v1'; }, v => { v[0].Config.Cmd = ['sh']; },
  v => { v[0].HostConfig.Ulimits[1].Hard = -1; }]) {
  test('different Docker isolation is rejected ' + mutate.toString().slice(7, 60), async () => {
    const state = containerState(); mutate(state);
    await assert.rejects(r.verifyContainer(q, async () => Buffer.from(JSON.stringify(state)), 'c'.repeat(64)));
  });
}
test('failure location must agree with failing child', () => {
  const value = terminal(); value.failingStep = 'postinstall';
  assert.throws(() => r.validateReport(value, 'build', 'a'.repeat(64), dictionary, q));
});
test('safe diagnostics survive uncertain teardown without claiming successful cleanup', async t => {
  const f = executionFixture(t, { teardownFails: true }); const result = await r.execute(f.digest, r.PHRASE, f.deps);
  assert.equal(result.stages.length, 1); assert.equal(result.stages[0].containerExit, null);
  assert.equal(result.teardownUnconfirmed, true); assert.equal(f.calls.filter(a => a[0] === 'kill').length, 1);
});
test('report persistence failure keeps lock and consumed reservation', async t => {
  const f = executionFixture(t);
  const fakeQ = { ...q, writeOnce(file, value) { if (file.endsWith('.report.json')) throw new Error(secret); return q.writeOnce(file, value); } };
  f.deps.qualification = () => fakeQ;
  const result = await r.execute(f.digest, r.PHRASE, f.deps);
  assert.equal(result.persistenceFailure, true); assert.equal(fs.existsSync(path.join(f.registry, 'active.lock')), true);
  assert.equal(fs.existsSync(path.join(f.registry, r.KEY + '.reservation.json')), true);
});
test('a persisted contract different from current bytes cannot execute', async t => {
  const f = executionFixture(t); f.deps.review = { changed: true };
  await assert.rejects(r.execute(f.digest, r.PHRASE, f.deps)); assert.equal(f.calls.length, 0);
});
