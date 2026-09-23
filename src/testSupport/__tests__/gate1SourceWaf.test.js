/** All trial I/O uses local fixtures. The byte test uses only a loopback TCP server. */
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CASES, LIMITS, createWireRequest, reviewSourceResponse, reviewWafEvidence,
  simulateTrial, preparationReport } = require('../../../scripts/gate1-source-waf.js');

const SECRET = 'a'.repeat(64);
const MARKER = `gate1-source-${'b'.repeat(32)}`;
const SENTINEL = 'PRIVATE_DATA_NEVER_RETAIN';
const AGGREGATE = { kind: 'aggregate', queryAccepted: true, markerMatched: true,
  rows: 1, count: 1, sampled: null, truncated: null };

/** Supplies the real probe's bounded schema in a synthetic anonymous response. */
function response(marker = MARKER, facts = {}) {
  return { status: 200, headers: {
    'cache-control': 'private, no-store', 'x-vercel-cache': 'BYPASS',
    'x-gate1-source-probe': JSON.stringify({
      schemaVersion: 1, scope: 'server_header_observation_only', marker,
      applicationRequestId: null, rawMetadataValid: true, trustedHeaderCount: 1,
      normalizedShape: 'scalar', rawNormalizedEqual: true, effectiveMode: 'vercel',
      sourceResolution: 'accepted', canonicalFamily: 4, sourceAgreement: 'not_evaluated', ...facts,
    }),
  }, body: JSON.stringify({ data: { user: null }, error: null, message: 'Success' }) };
}

/** Creates one-request trial dependencies with no network transport. */
function trialOptions(overrides = {}) {
  return { caseIds: ['discovery'], markerFor: () => MARKER,
    exchange: jest.fn(async ({ marker }) => response(marker)),
    lookup: jest.fn(async () => AGGREGATE), ...overrides };
}

/** Sends bytes only to an ephemeral loopback listener and closes both sockets. */
async function captureLoopback(wire) {
  const sockets = new Set();
  const server = net.createServer();
  let client;
  let timer;
  try {
    const received = new Promise((resolve, reject) => {
      server.on('error', reject);
      server.on('connection', (socket) => {
        sockets.add(socket);
        let text = '';
        socket.on('error', reject);
        socket.on('data', (data) => {
          text += data.toString('ascii');
          if (text.includes('\r\n\r\n')) resolve(text);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        client = net.connect({ host: '127.0.0.1', port: server.address().port }, () => client.write(wire));
        client.on('error', reject);
      });
      timer = setTimeout(() => reject(new Error('loopback_deadline')), 2000);
    });
    return await received;
  } finally {
    clearTimeout(timer);
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

describe('source/WAF local diagnostic helpers', () => {
  it('preserves duplicate/case-variant headers in actual loopback bytes', async () => {
    const wire = createWireRequest({ hostname: 'localhost', marker: MARKER, secret: SECRET, caseId: 'duplicate_casing' });
    const received = await captureLoopback(wire);
    expect(received).toContain('x-vercel-forwarded-for: 192.0.2.71\r\nX-Vercel-Forwarded-For: 192.0.2.72\r\n');
    expect(received.match(/vercel-forwarded-for/gi)).toHaveLength(2);
    expect(received).toBe(wire.toString('ascii'));
  });

  it.each([['leading_space', ':  192.0.2.71\r\n'], ['trailing_space', ': 192.0.2.71 \r\n'],
    ['internal_space', ': 192.0. 2.71\r\n']])('preserves %s bytes without claiming platform preservation', (caseId, expected) => {
    expect(createWireRequest({ hostname: 'localhost', marker: MARKER, secret: SECRET, caseId }).toString('ascii')).toContain(expected);
  });

  it.each([{ hostname: 'localhost\r\nX-Evil: 1' }, { secret: 'short' }, { marker: 'unbounded' }, { caseId: 'unknown' }])(
    'rejects injection/unknown wire inputs (%#)', (override) => {
      expect(() => createWireRequest({ hostname: 'localhost', marker: MARKER, secret: SECRET, caseId: 'control', ...override }))
        .toThrow('fixture_input');
    }
  );

  it('never qualifies even a matching single aggregate', () => {
    expect(reviewWafEvidence(AGGREGATE)).toEqual({ availability: 'aggregate_candidate',
      correlation: 'unqualified', completeness: 'unqualified', sourceAgreement: 'not_evaluated' });
    expect(reviewWafEvidence({ ...AGGREGATE, sampled: false, truncated: false }).sourceAgreement).toBe('not_evaluated');
  });

  it.each([{ rows: 2 }, { count: 2 }, { markerMatched: false }, { sampled: true }, { truncated: true }])(
    'does not accept ambiguous/delayed/sampled/truncated aggregates (%#)', (change) => {
      expect(reviewWafEvidence({ ...AGGREGATE, ...change }).availability).toBe('ambiguous');
    }
  );

  it('rejects unsupported receipts and strips any provider payload from disposition', () => {
    const result = reviewWafEvidence({ ...AGGREGATE, clientIp: SENTINEL, digest: SECRET });
    expect(result.availability).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('projects a valid response without retaining markers, request IDs, headers or body', () => {
    const candidate = response();
    candidate.headers.unrelated = SENTINEL;
    const facts = reviewSourceResponse(candidate, MARKER);
    expect(facts.canonicalFamily).toBe(4);
    expect(facts.marker).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain(SENTINEL);
  });

  it.each([
    { sourceAgreement: 'qualified' }, { marker: `gate1-source-${'c'.repeat(32)}` },
    { privateAddress: SENTINEL }, { canonicalFamily: null }, { normalizedShape: 'array' },
    { trustedHeaderCount: 2 }, { effectiveMode: 'local' }, { rawNormalizedEqual: false },
  ])('rejects schema/correlation/parser contradictions (%#)', (facts) => {
    expect(() => reviewSourceResponse(response(MARKER, facts), MARKER)).toThrow('probe_contract');
  });

  it.each([
    ['redirect', { status: 302 }], ['session_status', { status: 429 }],
    ['body_contract', { body: 'x'.repeat(LIMITS.responseBytes + 1) }],
    ['body_contract', { body: JSON.stringify({ data: { user: { id: SENTINEL } }, error: null, message: 'Success' }) }],
  ])('stops for %s before subsequent cases', async (failure, changes) => {
    const options = trialOptions({ caseIds: ['discovery', 'control'], exchange: jest.fn(async () => ({ ...response(), ...changes })) });
    const report = await simulateTrial(options);
    expect(report.failure).toBe(failure);
    expect(report.appAttempts).toBe(1);
    expect(options.lookup).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });

  it.each([
    ['cache-control', 'public, max-age=10'], ['x-vercel-cache', 'HIT'], ['set-cookie', SENTINEL],
    ['x-gate1-source-probe', 'x'.repeat(LIMITS.probeHeaderBytes + 1)],
    ['x-gate1-source-probe', [SENTINEL, SENTINEL]],
  ])('rejects unsafe %s metadata (%#)', (name, value) => {
    const candidate = response();
    candidate.headers[name] = value;
    expect(() => reviewSourceResponse(candidate, MARKER)).toThrow();
  });

  it('runs cases sequentially with unique markers while retaining only local evidence', async () => {
    let active = 0;
    let maxActive = 0;
    const options = trialOptions({ caseIds: CASES.map((item) => item.id),
      markerFor: (id) => `gate1-source-${CASES.findIndex((item) => item.id === id).toString(16).padStart(32, '0')}`,
      exchange: jest.fn(async ({ marker }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return response(marker);
      }),
    });
    const report = await simulateTrial(options);
    expect(report).toMatchObject({ result: 'completed', appAttempts: 19, providerAttempts: 19,
      validated: 19, mode: 'fixture', hostedEvidence: 'not_executed', sourceAgreement: 'not_evaluated', gate1Status: 'open' });
    expect(maxActive).toBe(1);
    expect(report.observations.every((item) => item.waf.correlation === 'unqualified')).toBe(true);
  });

  it('stops after two empty lookups, without replaying the application request', async () => {
    const options = trialOptions({ lookup: jest.fn(async () => ({ ...AGGREGATE, rows: 0, count: 0 })) });
    const report = await simulateTrial(options);
    expect(report).toMatchObject({ result: 'stopped', appAttempts: 1, providerAttempts: 2, failure: 'provider_unqualified' });
    expect(options.exchange).toHaveBeenCalledTimes(1);
    expect(options.lookup).toHaveBeenCalledTimes(2);
  });

  it('contains private transport exceptions with no replay or raw error output', async () => {
    const options = trialOptions({ exchange: jest.fn(async () => { throw new Error(SENTINEL); }) });
    const report = await simulateTrial(options);
    expect(report.failure).toBe('fixture_failure');
    expect(report.appAttempts).toBe(1);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(options.lookup).not.toHaveBeenCalled();
  });

  it('aborts a hanging attempt at its deadline without dispatching another one', async () => {
    let signal;
    const options = trialOptions({ requestMs: 5, exchange: ({ signal: attemptSignal }) => {
      signal = attemptSignal;
      return new Promise(() => {});
    } });
    const report = await simulateTrial(options);
    expect(signal.aborted).toBe(true);
    expect(report).toMatchObject({ failure: 'deadline', appAttempts: 1, providerAttempts: 0 });
  });

  it('enforces the overall deadline between application completion and provider lookup', async () => {
    const clock = [0, 1, LIMITS.overallMs];
    const options = trialOptions({ now: () => clock.shift() });
    const report = await simulateTrial(options);
    expect(report).toMatchObject({ failure: 'deadline', appAttempts: 1, providerAttempts: 0 });
    expect(options.lookup).not.toHaveBeenCalled();
  });

  it.each([[], Array(22).fill('discovery'), ['discovery', 'discovery'], ['unknown']].map((cases) => [cases]))(
    'rejects invalid or oversized profiles before any attempt (%#)', async (caseIds) => {
      const options = trialOptions({ caseIds });
      expect(await simulateTrial(options)).toMatchObject({ failure: 'fixture_input', appAttempts: 0 });
      expect(options.exchange).not.toHaveBeenCalled();
    }
  );

  it('refuses live CLI mode without echoing private arguments', () => {
    const cli = path.resolve(__dirname, '../../../scripts/gate1-source-waf.js');
    const result = spawnSync(process.execPath, [cli, '--live', SENTINEL], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Only --prepare');
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    const prepared = spawnSync(process.execPath, [cli, '--prepare'], { encoding: 'utf8' });
    expect(prepared.status).toBe(0);
    expect(JSON.parse(prepared.stdout)).toEqual(preparationReport());
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell launcher performs zero-traffic preparation', () => {
    const launcher = path.resolve(__dirname, '../../../scripts/run-gate1-source-waf.ps1');
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', launcher], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ mode: 'prepare', appRequests: 0, providerRequests: 0, liveExecution: 'not_implemented' });
  });
});
