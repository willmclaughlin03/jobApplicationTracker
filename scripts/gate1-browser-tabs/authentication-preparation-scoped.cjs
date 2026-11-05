'use strict';
/* global __dirname, __filename, process, Buffer, setTimeout, clearTimeout */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { z } = require('zod');
const c = require('./authentication-preparation-scoped-contract.cjs');
const p = require('./authentication-preparation-scoped-postflight.cjs');
const { ScopedProxy } = require('./authentication-preparation-scoped-proxy.cjs');
const { CdpConnection, ScopedObserver, MESSAGE_BYTES } = require('./authentication-preparation-scoped-observer.cjs');
const a = require('./authentication-preparation.cjs');
const d = require('./hosted-csrf-diagnostic.cjs');
const b = require('./hosted-csrf-build-attribution.cjs');
const f = require('./request-client-isolation.cjs');
const comparison = require('./page-lifecycle-diagnostic.cjs');
const CORE = 'C:/Users/willm/AppData/Local/npm-cache/_npx/a5b920f00216d246/node_modules/playwright-core';
const UTILS_HASH = '580f571bf063e2256b51b3946a035bc452fc0e22808d5547b198baea39923a32';
const DECISION_FILE = path.resolve(__dirname, '../../docs/UIDesign/gate1-authentication-measurement-decision.md');
const MODULES = Object.freeze(['authentication-preparation-scoped', 'authentication-preparation-scoped-contract',
  'authentication-preparation-scoped-proxy', 'authentication-preparation-scoped-observer', 'authentication-preparation-scoped-postflight',
  'authentication-preparation-scoped-native', 'authentication-preparation-scoped-native-contract', 'authentication-preparation-scoped-native-fixtures']);
const FILES = Object.freeze([...MODULES.flatMap(name => [`${name}.cjs`, `__tests__/${name}.test.cjs`]),
  'fixtures/scoped-native-loopback-cert.pem', 'fixtures/scoped-native-loopback-key.pem']);
const syntheticOwners = new WeakMap();
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const REVIEW_SCHEMA = z.object({ scope: z.literal('scoped-authentication-execution-review-v1'),
  operator: z.literal('Codex'), owner: z.literal('project-owner'), planHash: HASH, qualificationHash: HASH,
  completionHash: HASH, sourceSet: HASH, decisionHash: HASH, toolSet: HASH,
  approvedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe() }).strict();
const QUALIFICATION_COMPLETION = z.object({ scope: z.literal('scoped_authentication_native'),
  phase: z.literal('passed'), exitCode: z.literal(0), receiptFinalized: z.literal(true),
  attemptHash: HASH, sourceSet: HASH, decisionHash: HASH, toolSet: HASH }).strict();

/** Read only reviewed aggregate inputs from the fixed real directory; never follow profile or credential paths. */
async function readReviewed(name, io = fs) {
  c.check(['execution-review.json', 'reviewed-plan.json', 'native-qualification.json', 'native-completion.json'].includes(name), 'approval');
  try {
    c.check(path.resolve(await io.realpath(p.DIRECTORY)) === path.resolve(p.DIRECTORY), 'approval');
    const file = path.join(p.DIRECTORY, name); const stat = await io.lstat(file);
    c.check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= c.LIMITS.receiptBytes, 'approval');
    const bytes = await io.readFile(file); c.check(bytes.length <= c.LIMITS.receiptBytes, 'approval');
    return { data: JSON.parse(bytes.toString('utf8')), hash: d.digest(bytes) };
  } catch { throw new c.PreparationError('approval'); }
}

/** Explicit review digest binds separate native receipt/completion and an expiring execution plan, never a boolean. */
async function loadReviewed(reviewHash, identity, read = readReviewed, now = Date.now()) {
  c.check(HASH.safeParse(reviewHash).success, 'approval');
  const reviewed = await read('execution-review.json'); const review = reviewed.data;
  c.check(reviewed.hash === reviewHash && REVIEW_SCHEMA.safeParse(review).success, 'approval');
  c.check(review.approvedAt <= now && now < review.expiresAt && review.expiresAt - review.approvedAt <= 3600000, 'expired');
  const manifest = await read('reviewed-plan.json'); c.check(manifest.hash === review.planHash, 'integrity');
  c.validatePlan(manifest.data, identity, now);
  c.check(manifest.data.approvedAt === review.approvedAt && manifest.data.expiresAt === review.expiresAt, 'approval');
  const qualified = await read('native-qualification.json');
  c.validateQualification(qualified.data, qualified.hash, manifest.data, review);
  const completion = await read('native-completion.json');
  c.check(completion.hash === review.completionHash && QUALIFICATION_COMPLETION.safeParse(completion.data).success
    && completion.data.attemptHash === qualified.data.attemptHash
    && ['sourceSet', 'decisionHash', 'toolSet'].every(key => completion.data[key] === manifest.data[key]), 'worker_completion');
  return { plan: manifest.data, planHash: manifest.hash, qualification: qualified.data,
    qualificationHash: qualified.hash, review, reviewHash };
}

/** Bind exact implementation, tests, documentation and consumed dependencies without self-referential hashes. */
async function sourceHashes() {
  const files = {};
  for (const file of FILES) files[file] = await a.hashFile(path.join(__dirname, file));
  const decisionHash = await a.hashFile(DECISION_FILE);
  const dependencies = await a.sourceHash();
  return { sourceSet: d.digest(JSON.stringify({ dependencies, decisionHash, files })), decisionHash };
}

/** Verify the pinned native toolchain read-only, including the newly used bounded WebSocket implementation. */
async function toolHashes() {
  const metadata = JSON.parse(await fs.readFile(path.join(CORE, 'package.json'), 'utf8'));
  const tools = { node: process.version, playwright: metadata.version,
    bundle: await a.hashFile(path.join(CORE, 'lib/coreBundle.js')),
    executable: await a.hashFile(f.fixtureExecutable('cft158')) };
  comparison.checkToolchain(tools, 'cft158'); comparison.checkPackage(await comparison.packageHashes());
  c.check(metadata.name === 'playwright-core' && await a.hashFile(path.join(CORE, 'lib/utilsBundle.js')) === UTILS_HASH, 'toolchain');
  return d.digest(JSON.stringify({ ...tools, utils: UTILS_HASH, cli: await b.toolHashes() }));
}

/** Clear diagnostics only in owned children; never print environment values or alter the parent session. */
function childEnvironment(env = process.env) {
  const result = { ...env };
  for (const name of ['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_OPTIONS', 'NODE_DEBUG']) delete result[name];
  return result;
}

/** A step shares the global deadline and cancellation; a timeout actively aborts owned work. */
async function step(budget, action, maximum = budget.limits.operationMs) {
  budget.check(); let timer; let onAbort;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { budget.check(); return action(budget.abort.signal); }),
      new Promise((_, reject) => {
        onAbort = () => reject(new c.PreparationError(budget.failure || 'cancelled'));
        budget.abort.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => budget.stop('deadline'), Math.max(1, Math.min(maximum, budget.deadline - budget.clock())));
      }),
    ]);
    budget.check(); return result;
  } catch (error) { budget.stop(c.errorCode(error)); throw new c.PreparationError(budget.failure); }
  finally { clearTimeout(timer); budget.abort.signal.removeEventListener('abort', onAbort); }
}

/** Bound cleanup separately; failure is retained and cannot reset the work deadline or first error. */
async function cleanup(budget, action, maximum = 10000) {
  let timer;
  try {
    c.check(budget.clock() < budget.end, 'deadline');
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new c.PreparationError('closure')), Math.max(1, Math.min(maximum, budget.end - budget.clock())));
    })]);
  } catch (error) { budget.stop(c.errorCode(error)); return null; }
  finally { clearTimeout(timer); }
}

/** Account the intentional request-client proxy bypass once; APIResponse disposal never reads cookie storage. */
async function requestIdentity(owner, budget, identity) {
  const token = budget.reserve('session', 'requestClient'); let response;
  try {
    response = await owner.context.request.get(`${d.ORIGIN}/api/auth/session`, {
      timeout: budget.limits.restartMs, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false,
    });
    budget.check(); budget.acknowledge(token); budget.confirm(token);
    c.check(response.status() === 200, 'identity');
    const bytes = await response.body(); budget.check(); c.check(bytes.length <= d.LIMITS.jsonBytes, 'identity');
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new c.PreparationError('identity'); }
    a.verifyIdentity(data, identity); budget.finish(token); return true;
  } finally { if (response) await response.dispose(); }
}

/** Six guarded metadata calls use their own reservations and preserve the frozen historical target. */
async function reconcileTarget(budget, deps) {
  for (const kind of ['project', 'alias', 'deployment']) {
    const token = budget.reserve('metadata', 'metadata');
    const data = await step(budget, signal => deps.metadata(kind, signal), budget.limits.metadataMs);
    d.validateMetadata(kind, data); budget.acknowledge(token); budget.confirm(token); budget.finish(token);
  }
}

/** Preserve stopped counts and uncertainty in a strict aggregate attempt, with no success-compatible receipt. */
async function stoppedAttempt(budget, input, checks, proxy, deps, artifacts) {
  const record = { schemaVersion: 2, scope: 'scoped_authentication_preparation', phase: 'stopped',
    decision: c.DECISION, decisionHash: input.plan.decisionHash, sourceSet: input.plan.sourceSet, planHash: input.planHash,
    startedAt: budget.startedAt, completedAt: budget.clock(), coverage: c.COVERAGE,
    firstFailure: budget.failure, traffic: budget.snapshot(), proxy: proxy?.snapshot() || null,
    checks: Object.fromEntries(c.CHECKS.map(key => [key, checks[key] === true])),
    browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open' };
  c.validateAttempt(record);
  const attemptHash = artifacts.reserved ? await cleanup(budget, () => deps.writeAttempt(record), 5000) : null;
  return { phase: 'stopped', firstFailure: budget.failure, receiptFinalized: false,
    failureEvidenceWritten: typeof attemptHash === 'string', browserTrafficMeasured: false,
    hostedQualified: false, gate1Status: 'open' };
}

/** Execute the reviewed two-launch lifecycle through owned adapters; tests supply mocked native boundaries. */
async function runScoped(input, identity, deps) {
  const { plan, planHash, qualification, qualificationHash, review } = input;
  c.validatePlan(plan, identity, deps.clock?.() ?? Date.now());
  c.validateQualification(qualification, qualificationHash, plan, review);
  c.check(review.planHash === planHash, 'integrity');
  const budget = new c.ScopedBudget({ clock: deps.clock || Date.now });
  if (input.startedAt !== undefined) {
    c.check(Number.isSafeInteger(input.startedAt) && input.startedAt >= plan.approvedAt
      && input.startedAt <= budget.clock(), 'approval');
    budget.startedAt = input.startedAt; budget.deadline = input.startedAt + c.LIMITS.wholeMs - c.LIMITS.cleanupMs;
    budget.end = input.startedAt + c.LIMITS.wholeMs;
  }
  budget.deadline = Math.min(budget.deadline, plan.expiresAt - budget.limits.cleanupMs);
  budget.end = Math.min(budget.end, plan.expiresAt);
  const owners = []; const checks = {}; let proxy; let proxyPort; const closures = []; const artifacts = { reserved: false };
  const cancel = () => budget.stop('cancelled');
  const removeCancel = deps.onCancel?.(cancel) || (() => {});
  const workTimer = setTimeout(() => budget.stop('deadline'), Math.max(1, budget.deadline - budget.clock()));
  // Ownership exists before start/launch can yield; abort closes forwarding immediately.
  const stop = () => {
    proxy?.seal();
    for (const owner of owners) if (owner.context) {
      owner.cancellation = Promise.resolve().then(() => deps.cancelRequests(owner)).catch(() => budget.stop('closure'));
    }
  };
  budget.abort.signal.addEventListener('abort', stop, { once: true });
  try {
    await step(budget, () => deps.preflight(input));
    await step(budget, () => deps.reserveArtifacts(artifacts));
    budget.require(artifacts.reserved, 'already_used');
    proxy = deps.proxy(budget); await step(budget, () => proxy.start()); proxyPort = proxy.port;
    await reconcileTarget(budget, deps);
    const first = { profile: plan.profile, closed: false, restart: false }; owners.push(first); budget.launch();
    await step(budget, () => deps.launch(first, proxy, budget));
    await step(budget, () => deps.observe(first, budget));
    proxy.open();
    await step(budget, signal => deps.manualSignIn(first, budget, signal), budget.limits.manualMs);
    checks.identityBeforeRestart = await step(budget, () => deps.pageIdentity(first, budget, identity));
    await step(budget, () => deps.summarize(first)); checks.pageEventsPaired = true;
    proxy.seal(); deps.stopObservation(first);
    const firstClosure = await step(budget, () => deps.close(first, budget)); closures.push(firstClosure);
    await step(budget, () => deps.inspect(firstClosure));
    const second = { profile: plan.profile, closed: false, restart: true }; owners.push(second); budget.launch();
    await step(budget, () => deps.launch(second, proxy, budget));
    checks.identityAfterRestart = await step(budget, () => deps.requestIdentity(second, budget, identity), budget.limits.restartMs);
    const secondClosure = await step(budget, () => deps.close(second, budget)); closures.push(secondClosure);
    await step(budget, () => deps.inspect(secondClosure));
    await reconcileTarget(budget, deps); checks.targetReconciled = true;
  } catch (error) { budget.stop(c.errorCode(error)); }
  finally {
    proxy?.seal();
    for (const owner of owners) {
      deps.stopObservation(owner);
      if (owner.cancellation) await cleanup(budget, () => owner.cancellation, 5000);
      if (!owner.closed) await cleanup(budget, () => deps.close(owner, budget));
      if (owner.child || owner.closed) await cleanup(budget, () => deps.inspect(deps.ownerRecord(owner)));
    }
    if (proxy) checks.listenersClosed = (await cleanup(budget, async () => { await proxy.close(); return true; })) === true;
    checks.profilePreserved = (await cleanup(budget, () => deps.profile())) === true;
    if (!checks.profilePreserved) budget.stop('profile');
    checks.normalClosure = owners.length === 2 && owners.every(owner => owner.closed);
    checks.independentProcessExit = !budget.failure && closures.length === 2;
    removeCancel(); clearTimeout(workTimer); budget.abort.signal.removeEventListener('abort', stop);
  }
  if (budget.failure) return stoppedAttempt(budget, input, checks, proxy, deps, artifacts);
  let attemptStarted = false;
  try {
    budget.check(); await step(budget, () => deps.verifyBindings(plan, planHash));
    const traffic = budget.snapshot(); const counts = traffic.counts;
    const increment = { application: counts.application, static: counts.canonicalStatic + counts.providerStatic, session: counts.session };
    const record = { schemaVersion: 2, scope: 'scoped_authentication_preparation', decision: c.DECISION,
      sourceSet: plan.sourceSet, decisionHash: plan.decisionHash, toolSet: plan.toolSet, qualificationHash,
      planHash, buildHash: plan.buildHash, target: plan.target, buildId: plan.buildId, profile: plan.profile,
      startedAt: budget.startedAt, completedAt: budget.clock(), phase: 'passed', coverage: c.COVERAGE,
      browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open', identityVerified: true,
      closedNormally: true, independentProcessExitVerified: true, checks, owners: closures,
      listenerPorts: [proxyPort], traffic, proxy: proxy.snapshot(), requests: { actual: increment, conservative: { ...increment } } };
    c.validateReceipt(record); attemptStarted = true;
    const attemptHash = await step(budget, () => deps.writeAttempt(record));
    return { phase: 'passed', receiptFinalized: true, attemptHash, sourceSet: plan.sourceSet, planHash };
  } catch (error) {
    budget.stop(c.errorCode(error));
    if (!attemptStarted) return stoppedAttempt(budget, input, checks, proxy, deps, artifacts);
    return { phase: 'stopped', firstFailure: budget.failure, receiptFinalized: false,
      browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open' };
  }
}

/** Pause only local polling; abort cancels the timer instead of leaving a late continuation. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new c.PreparationError('cancelled')); };
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Read only fresh DevTools attachment metadata, not profile cookies, tokens or storage. */
async function attachment(owner, budget, cleanupOnly = false) {
  const file = path.join(owner.profile, 'DevToolsActivePort');
  const end = Math.min(cleanupOnly ? budget.end : budget.deadline, Date.now() + (cleanupOnly ? 5000 : 10000));
  while (Date.now() < end) {
    if (!cleanupOnly) budget.check(); c.check(!owner.failed && owner.child.exitCode === null, 'closure');
    try {
      const stat = await fs.lstat(file);
      c.check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024, 'profile');
      if (stat.mtimeMs >= owner.launchTime) {
        const [rawPort, endpoint] = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/);
        const port = Number(rawPort);
        c.check(Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[a-f0-9-]+$/.test(endpoint), 'profile');
        owner.port = port; owner.endpoint = endpoint; return;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50, cleanupOnly ? undefined : budget.abort.signal);
  }
  throw new c.PreparationError('deadline');
}

/** Create the sole bounded CDP transport for the first launch, owning the socket before waiting for open. */
async function connectController(owner, budget, cleanupOnly = false) {
  if (!cleanupOnly) budget.check();
  const { ws } = require(path.join(CORE, 'lib/utilsBundle.js'));
  owner.socket = new ws(`ws://127.0.0.1:${owner.port}${owner.endpoint}`, {
    maxPayload: MESSAGE_BYTES, perMessageDeflate: false, handshakeTimeout: 5000,
  });
  owner.cdp = new CdpConnection(owner.socket, budget);
  if (cleanupOnly) owner.cdp.closing = true;
  if (syntheticOwners.has(owner)) nativeController(owner, budget);
  await new Promise((resolve, reject) => { owner.socket.once('open', resolve); owner.socket.once('error', () => reject(new c.PreparationError('observation'))); });
  if (!cleanupOnly) {
    try { budget.check(); } catch (error) { owner.cdp.close(); throw error; }
  }
}

/** Launch behind a closed proxy; Playwright is attached only to the rejecting-proxy restart. */
async function launch(owner, proxy, budget) {
  const policy = syntheticOwners.get(owner);
  if (policy) await p.nativeProfile(owner.profile);
  else { c.check(owner.profile === d.PROFILE, 'profile'); await p.profilePreserved(); }
  budget.check(); owner.launchTime = Date.now();
  // The approved identity is worker-only; Chrome keeps the remaining sanitized environment.
  const env = childEnvironment(); delete env.GATE1_APPROVED_USER_ID;
  owner.child = spawn(f.fixtureExecutable('cft158'), [`--user-data-dir=${owner.profile}`, '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--disable-background-networking', '--disable-quic', '--no-startup-window', ...f.isolationArguments(proxy.port),
    ...(policy ? [`--ignore-certificate-errors-spki-list=${policy.spki}`, '--site-per-process'] : [])],
  { stdio: 'ignore', windowsHide: true, env });
  owner.child.once('error', () => { owner.failed = true; budget.stop('operation'); });
  await attachment(owner, budget);
  budget.check();
  if (!owner.restart) { await connectController(owner, budget); return; }
  const runtime = require(CORE);
  owner.browser = policy ? await nativePlaywright(owner, budget, runtime)
    : await runtime.chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`, { noDefaults: true, timeout: 5000 });
  budget.check(); const contexts = owner.browser.contexts(); c.check(contexts.length === 1, 'observation');
  owner.context = contexts[0];
  c.check(owner.context.serviceWorkers().length === 0 && owner.context.pages().length === 0, 'observation');
  owner.context.on('serviceworker', () => budget.stop('observation'));
  owner.context.on('page', () => budget.stop('observation'));
  owner.context.on('request', () => budget.stop('observation'));
}

/** Prepare both blank targets before opening forwarding; unsupported ordering fails closed. */
async function observe(owner, budget) {
  const policy = syntheticOwners.get(owner);
  owner.observer = new ScopedObserver(owner.cdp, budget, policy?.classify);
  if (policy?.missingPair) {
    const handle = owner.observer.handle.bind(owner.observer);
    /** Withhold one actual Fetch event; its Network counterpart still reserves capacity in the real observer. */
    owner.observer.handle = message => {
      if (message.method === 'Fetch.requestPaused' && !owner.native.realEventWithheld) {
        budget.event(); owner.native.realEventWithheld = true; return;
      }
      handle(message);
    };
  }
  await owner.observer.start();
  owner.keeper = await owner.observer.createPage(); owner.page = await owner.observer.createPage();
}

/** Permit one owner-operated sign-in; local boolean polling generates no additional HTTP requests. */
async function manualSignIn(owner, budget, signal) {
  const origin = syntheticOwners.get(owner)?.origin || d.ORIGIN;
  owner.observer.phase = 'oauth';
  const navigation = await owner.cdp.send('Page.navigate', { url: `${origin}/login` }, owner.page.sessionId);
  c.check(!navigation.errorText, 'operation');
  const end = Math.min(budget.deadline, Date.now() + budget.limits.manualMs);
  while (Date.now() < end) {
    const result = await owner.cdp.send('Runtime.evaluate', {
      expression: `location.origin === ${JSON.stringify(origin)} && location.pathname === '/'`, returnByValue: true,
    }, owner.page.sessionId, false, { contextLossAsFalse: true });
    budget.check(); c.check(Date.now() < end, 'deadline');
    c.check(!result.exceptionDetails, 'observation'); if (result.result?.value === true) return;
    await delay(250, signal);
  }
  throw new c.PreparationError('deadline');
}

/** Verify identity in memory through the observed page; the browser fetch has its own real cancellation timer. */
async function pageIdentity(owner, budget, identity) {
  owner.observer.phase = 'verify';
  const result = await owner.cdp.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
    expression: `(async () => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
      try { const response = await fetch('/api/auth/session', { credentials: 'include', redirect: 'error', signal: controller.signal });
        if (response.status !== 200) return null; const body = await response.arrayBuffer();
        if (body.byteLength > ${d.LIMITS.jsonBytes}) return null;
        return JSON.parse(new TextDecoder().decode(body)); } finally { clearTimeout(timer); } })()`,
  }, owner.page.sessionId);
  budget.check(); c.check(!result.exceptionDetails, 'identity'); return a.verifyIdentity(result.result?.value, identity);
}

/** Close normally using the existing controller or restart Playwright; actual zero process exit is mandatory. */
async function close(owner, budget) {
  if (owner.closed) return ownerRecord(owner);
  if (syntheticOwners.has(owner)) {
    owner.nativeClosing = true;
    // A failed Playwright attachment owns its transport; retire it before raw normal-close recovery.
    if (owner.restart && !owner.browser?.isConnected()) { owner.nativeTransport?.close(); owner.restart = false; }
  }
  if (!owner.restart) {
    if ((!owner.cdp || owner.cdp.closed || owner.socket?.readyState !== 1) && owner.child?.exitCode === null) {
      owner.cdp?.close();
      await attachment(owner, budget, true); await connectController(owner, budget, true);
    }
    if (owner.cdp && !owner.cdp.closed) {
      owner.cdp.closing = true;
      await owner.cdp.send('Browser.close', {}, undefined, true).catch(() => {});
    }
  } else {
    await f.closeOwned(owner, require(CORE), Math.min(budget.end, Date.now() + 5000));
  }
  const end = Math.min(budget.end, Date.now() + 5000);
  while (owner.child?.exitCode === null && Date.now() < end) await delay(50);
  c.check(owner.child?.exitCode === 0 && !owner.failed, 'closure'); owner.closed = true;
  owner.cdp?.close(); return ownerRecord(owner);
}

/** Bound the pinned in-process Playwright transport before its first CDP command; do not patch package files. */
async function nativePlaywright(owner, budget, runtime) {
  c.check(syntheticOwners.has(owner), 'approval');
  const implementation = runtime.chromium._connection?.toImpl?.(runtime.chromium);
  c.check(typeof implementation?._connectOverCDPImpl === 'function', 'toolchain');
  const original = implementation._connectOverCDPImpl;
  /** Install the exact pinned transport seam before CRBrowser creates or resumes targets. */
  implementation._connectOverCDPImpl = async function (progress, transport, closeAndWait, options, onClose) {
    owner.nativeTransport = transport;
    c.check(transport._ws?._receiver && typeof transport.send === 'function' && typeof transport.close === 'function', 'toolchain');
    transport._ws._receiver._maxPayload = MESSAGE_BYTES;
    transport._progress = null; // Never retain raw malformed protocol in Playwright progress logs.
    const send = transport.send.bind(transport); const pending = new Map(); let receive; let closed = false;
    /** Cancel timers and stop future work on unexpected closure, including an idle transport with no pending commands. */
    transport._ws.once('close', () => {
      closed = true; for (const timer of pending.values()) clearTimeout(timer); pending.clear();
      if (!owner.nativeClosing) budget.stop('observation');
    });
    /** Apply the global command ceiling and per-message/pending limits before enqueueing bytes. */
    transport.send = message => {
      const closing = owner.nativeClosing === true;
      try {
        c.check(!closed, 'observation');
        c.check(!closing || ['Target.attachToBrowserTarget', 'Target.detachFromTarget', 'Browser.close'].includes(message.method), 'observation');
        if (!closing) budget.check(); budget.command(closing);
        c.check(Buffer.byteLength(JSON.stringify(message)) <= MESSAGE_BYTES && pending.size < budget.limits.pendingCommands
          && Number.isInteger(message.id) && !pending.has(message.id), 'observation');
        const remaining = Math.min(5000, (closing ? budget.end : budget.deadline) - budget.clock()); c.check(remaining > 0, 'deadline');
        pending.set(message.id, setTimeout(() => { budget.stop('deadline'); transport.close(); }, remaining)); send(message);
      } catch (error) { budget.stop(c.errorCode(error)); transport.close(); throw new c.PreparationError(c.errorCode(error)); }
    };
    Object.defineProperty(transport, 'onmessage', { configurable: true,
      /** Preserve Playwright's callback assignment while wrapping only its bounded transport boundary. */
      set: callback => { receive = callback; },
      /** Validate replies/events privately and never throw raw protocol into Playwright's logger. */
      get: () => message => {
        if (closed) return;
        try {
          c.check(Buffer.byteLength(JSON.stringify(message)) <= MESSAGE_BYTES, 'observation');
          if (Object.hasOwn(message, 'id')) {
            c.check(pending.has(message.id), 'observation'); clearTimeout(pending.get(message.id)); pending.delete(message.id);
          } else if (/^(Target\.|Fetch\.|Network\.|Inspector\.)/.test(message.method || '') && !owner.nativeClosing) budget.event();
          receive?.(message);
        } catch (error) { budget.stop(c.errorCode(error)); transport.close(); }
      },
    });
    try { return await original.call(this, progress, transport, closeAndWait, options, onClose); }
    catch (error) { transport.close(); throw error; }
  };
  try { return await runtime.chromium.connectOverCDP(`ws://127.0.0.1:${owner.port}${owner.endpoint}`, { noDefaults: true, timeout: 5000 }); }
  finally { implementation._connectOverCDPImpl = original; }
}

/** Project only fixed-profile process metadata for independent postflight. */
function ownerRecord(owner) {
  return { profile: syntheticOwners.has(owner) ? owner.profile : d.PROFILE, pid: owner.child?.pid,
    port: owner.port, closedNormally: owner.closed === true, exitCode: owner.child?.exitCode };
}

/** Observe native command acknowledgements and actual errors privately, without changing protocol replies. */
function nativeController(owner, budget) {
  const policy = syntheticOwners.get(owner); const connection = owner.cdp;
  const send = connection.send.bind(connection); const setup = new Map();
  owner.native ||= { pageReady: 0, frameReady: 0, contextLoss: 0, replacements: 0, contextReplacements: 0, nativeError: false,
    nativeDetach: false, workerObserved: false, realEventWithheld: false };
  /** Inspect a real inbound frame before the controller consumes it; retain categories only. */
  owner.socket.prependListener('message', bytes => {
    try {
      c.check(bytes.length <= MESSAGE_BYTES, 'observation'); const message = JSON.parse(bytes.toString());
      const pending = connection.pending.get(message.id);
      if (message.error && pending) {
        if (pending.contextLossAsFalse && message.error.code === -32000
          && ['Cannot find context with specified id', 'Cannot find default execution context',
            'Execution context was destroyed.', 'Inspected target navigated or closed'].includes(message.error.message)) owner.native.contextLoss++;
        else owner.native.nativeError = true;
      }
      if (message.method === 'Target.detachedFromTarget') owner.native.nativeDetach = true;
      if (['Target.targetCreated', 'Target.attachedToTarget'].includes(message.method)
        && ['service_worker', 'worker', 'shared_worker'].includes(message.params?.targetInfo?.type)) owner.native.workerObserved = true;
      if (!owner.observer && !owner.nativeClosing && /^(Target\.|Fetch\.|Network\.|Inspector\.)/.test(message.method || '')) budget.event();
      if (policy.navigation && message.method === 'Runtime.executionContextsCleared' && !owner.nativeClosing) {
        budget.event(); owner.native.contextReplacements++;
      }
    } catch { budget.stop('observation'); }
  });
  /** Charge before sending and use only real completion acknowledgements for target setup evidence. */
  connection.send = async (method, params = {}, session, cleanupOnly = false, options = {}) => {
    budget.command(cleanupOnly);
    const pending = send(method, params, session, cleanupOnly, options);
    if (method === 'Runtime.evaluate' && options.contextLossAsFalse && policy.navigation) {
      const next = owner.native.replacements;
      if (next < 16) {
        owner.native.replacements++;
        const route = next === 15 && policy.navigation === 'recover' ? '/' : next % 2 ? '/nav-a' : '/nav-b';
        // A real concurrent navigation races the actual synchronous location poll; no error is fabricated.
        connection.send('Page.navigate', { url: `${policy.origin}${route}` }, session).catch(() => budget.stop('observation'));
      }
    }
    const result = await pending;
    if (session && ['Network.enable', 'Network.setCacheDisabled', 'Network.setBypassServiceWorker', 'Fetch.enable'].includes(method)) {
      if (!setup.has(session)) setup.set(session, new Set()); setup.get(session).add(method);
    }
    if (method === 'Runtime.runIfWaitingForDebugger') {
      if (policy.workerSetup && owner.workerReady?.has(session)) return result;
      c.check(setup.get(session)?.size === 4, 'observation');
      const target = owner.observer?.targets.get(session); c.check(target?.ready, 'observation');
      owner.native[target.type === 'iframe' ? 'frameReady' : 'pageReady']++;
    }
    return result;
  };
}

/** Produce only fixed synthetic adapters; live CLI entry points never receive these policies or paths. */
function syntheticAdapters(caseId, navigation = null) {
  const n = require('./authentication-preparation-scoped-native-contract.cjs');
  c.check(n.PROFILE_NAMES.includes(caseId) && (navigation === null
    || (caseId === 'lifecycle' && navigation === 'recover') || (caseId === 'manual-deadline' && navigation === 'deadline')), 'approval');
  const policy = Object.freeze({ origin: n.ORIGIN, spki: n.SPKI, classify: n.classify, navigation,
    missingPair: caseId === 'missing-pair', workerSetup: caseId === 'restored-worker' });
  return {
    /** Register an exact profile before shared launch; no expected real identity reaches this adapter. */
    launch: async (owner, proxy, budget) => {
      c.check(owner.profile === n.profile(caseId) && budget instanceof n.NativeBudget && proxy.listenPort === 18445, 'approval');
      syntheticOwners.set(owner, policy); return launch(owner, proxy, budget);
    },
    observe, close, ownerRecord, pageIdentity: (owner, budget) => pageIdentity(owner, budget, n.ID),
    /** Enable real execution-context lifecycle witnesses before using the unchanged bounded manual poll. */
    manualSignIn: async (owner, budget, signal) => {
      await owner.cdp.send('Runtime.enable', {}, owner.page.sessionId); return manualSignIn(owner, budget, signal);
    },
    inspect: p.inspectNativeClosure, profile: () => p.nativeProfile(n.profile(caseId)),
    /** Reserve each fixed loopback bypass explicitly; certificate exceptions never affect another destination. */
    request: async (owner, budget, route) => {
      c.check(syntheticOwners.has(owner) && ['/api/auth/session', '/api/native/writeback', '/api/native/hold'].includes(route), 'destination');
      const token = budget.reserve(n.classify(`${n.ORIGIN}${route}`, 'GET'), 'requestClient'); let response;
      try {
        response = await owner.context.request.get(`${n.ORIGIN}${route}`, { timeout: budget.limits.restartMs,
          maxRedirects: 0, maxRetries: 0, failOnStatusCode: false, ignoreHTTPSErrors: true });
        budget.check(); budget.acknowledge(token); budget.confirm(token); c.check(response.status() === 200, 'identity');
        const bytes = await response.body(); budget.check(); c.check(bytes.length <= d.LIMITS.jsonBytes, 'identity');
        if (route === '/api/auth/session') a.verifyIdentity(JSON.parse(bytes.toString('utf8')), n.ID);
        budget.finish(token); return true;
      } finally { if (response) await response.dispose(); }
    },
  };
}

/** Verify exact immutable inputs again; historical attribution is accepted only on its frozen target. */
async function verifyBindings(plan, planHash) {
  const sources = await sourceHashes();
  c.check(sources.sourceSet === plan.sourceSet && sources.decisionHash === plan.decisionHash
    && await toolHashes() === plan.toolSet, 'integrity');
  c.check(await a.hashFile(path.join(d.DIRECTORY, 'build-attribution.json')) === plan.buildHash
    && await a.hashFile(path.join(d.DIRECTORY, 'build-attribution-plan.json')) === a.MANIFEST_HASH, 'integrity');
  await d.historyHashes();
  const current = await d.readJson(path.join(p.DIRECTORY, 'reviewed-plan.json'));
  c.check(current.hash === planHash && JSON.stringify(current.data) === JSON.stringify(plan), 'integrity');
}

/** Supply native implementations without performing any I/O until the reviewed runner calls them. */
function nativeDependencies() {
  const metadataOwners = [];
  return {
    clock: Date.now, proxy: budget => new ScopedProxy(budget), launch, observe, manualSignIn, pageIdentity,
    requestIdentity, ownerRecord, close, inspect: p.inspectClosure, profile: p.profilePreserved, verifyBindings,
    metadata: (kind, signal) => b.metadata(kind, signal, metadataOwners),
    cancelRequests: owner => owner.context.request.dispose({ reason: 'scoped_preparation_stopped' }),
    summarize: owner => owner.observer.summary(), stopObservation: owner => owner.observer?.close(),
    writeAttempt: record => p.writeExclusive(p.ATTEMPT, record),
    /** Require reviewed hashes and complete process absence before creating any browser artifacts. */
    preflight: async input => {
      const current = await loadReviewed(input.reviewHash, process.env.GATE1_APPROVED_USER_ID);
      c.check(current.planHash === input.planHash && current.qualificationHash === input.qualificationHash, 'integrity');
      await verifyBindings(input.plan, input.planHash); await p.inspectAbsence();
    },
    /** Reserve fixed single-use marker/profile exclusively; never overwrite a consumed attempt. */
    reserveArtifacts: async artifacts => {
      c.check(path.resolve(await fs.realpath(p.DIRECTORY)) === path.resolve(p.DIRECTORY), 'profile');
      const marker = await fs.open(path.join(p.DIRECTORY, 'worker-started'), 'wx'); artifacts.reserved = true; await marker.close();
      await fs.mkdir(d.PROFILE); await p.profilePreserved();
    },
    /** IPC/signal cancellation stops actual owned activity and is removed after cleanup. */
    onCancel: cancel => {
      const message = value => { if (value?.cancel === true) cancel(); };
      process.on('message', message); process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('disconnect', cancel);
      return () => { process.removeListener('message', message); process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel); process.removeListener('disconnect', cancel); };
    },
  };
}

/** Supervise bounded aggregate IPC and actual worker exit; no stdout/private error stream is retained. */
async function supervise(plan, planHash, verify, deps = {}) {
  c.check(deps.spawn || HASH.safeParse(deps.reviewHash).success, 'approval');
  const start = deps.spawn || spawn; const clock = deps.clock || Date.now;
  const startedAt = clock(); const end = Math.min(startedAt + c.LIMITS.wholeMs, plan.expiresAt);
  const completion = await new Promise((resolve, reject) => {
    const child = start(process.execPath, [__filename, '--scoped-worker', deps.reviewHash, String(startedAt)], { windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: childEnvironment() });
    let message; let invalid = false; let finished = false;
    const cancel = () => { if (child.connected) child.send({ cancel: true }, () => {}); };
    const workTimer = setTimeout(cancel, Math.max(1, end - c.LIMITS.cleanupMs - clock()));
    const endTimer = setTimeout(() => { invalid = true; cancel(); finish(new c.PreparationError('worker_completion')); }, Math.max(1, end - clock()));
    /** Remove supervisor listeners/timers once; a late worker never finalizes a previously timed-out attempt. */
    function finish(error, code) {
      if (finished) return; finished = true; clearTimeout(workTimer); clearTimeout(endTimer);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      if (error || invalid || !message) reject(error || new c.PreparationError('worker_completion'));
      else resolve({ ...message, exitCode: code });
    }
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    child.on('message', value => {
      if (message || Buffer.byteLength(JSON.stringify(value)) > 2048) { invalid = true; cancel(); }
      else message = value;
    });
    child.once('error', () => finish(new c.PreparationError('worker_completion')));
    child.once('close', code => finish(null, code));
  });
  if (completion.phase === 'stopped') throw new c.PreparationError(completion.firstFailure);
  c.check(p.completionSchema.safeParse(completion).success, 'worker_completion');
  c.check(completion.planHash === planHash, 'integrity');
  return (deps.finalize || p.finalize)(completion, plan, verify, { deadline: end, clock });
}

/** Live entry requires a separately reviewed digest and matching native completion; no such approval is bundled. */
async function main(args) {
  if (args.length === 1 && args[0] === '--source-hash') return sourceHashes();
  if (['--execute-scoped', '--scoped-worker'].includes(args[0])) {
    const worker = args[0] === '--scoped-worker';
    c.check(args.length === (worker ? 3 : 2) && HASH.safeParse(args[1]).success, 'coverage_unqualified');
    if (worker) c.check(process.connected === true && /^\d{1,16}$/.test(args[2]), 'approval');
    const identity = process.env.GATE1_APPROVED_USER_ID;
    const input = await loadReviewed(args[1], identity);
    if (worker) {
      input.startedAt = Number(args[2]); const result = await runScoped(input, identity, nativeDependencies());
      await new Promise((resolve, reject) => process.send(result, error => error ? reject(new c.PreparationError('worker_completion')) : resolve()));
      process.disconnect(); if (result.phase !== 'passed') process.exitCode = 1; return result;
    }
    await verifyBindings(input.plan, input.planHash); await p.inspectAbsence();
    return supervise(input.plan, input.planHash, async (plan, planHash) => {
      await loadReviewed(args[1], identity); await verifyBindings(plan, planHash);
    }, { reviewHash: args[1] });
  }
  throw new c.PreparationError('arguments');
}

module.exports = { CORE, UTILS_HASH, DECISION_FILE, MODULES, FILES, sourceHashes, toolHashes, childEnvironment,
  REVIEW_SCHEMA, QUALIFICATION_COMPLETION, readReviewed, loadReviewed,
  step, cleanup, requestIdentity, reconcileTarget, stoppedAttempt, runScoped, delay, attachment, connectController,
  launch, observe, manualSignIn, pageIdentity, close, ownerRecord, verifyBindings, nativeDependencies, supervise, main,
  syntheticAdapters, nativeController, nativePlaywright };
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'),
  error => { process.stderr.write(JSON.stringify({ phase: 'stopped', firstFailure: c.errorCode(error) }) + '\n'); process.exitCode = 1; });
