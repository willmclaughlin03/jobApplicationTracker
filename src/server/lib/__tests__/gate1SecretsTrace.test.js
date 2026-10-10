import { createGate1SecretsTrace, parseGate1SecretsStageRecord, reviewGate1SecretsStageRecords } from '../gate1SecretsTrace.js';
import { createGate1SecretsProbe } from '../gate1SecretsProbe.js';

const mockLines = [];
let attachRequestLogger;
// Keep the real application logger options/bindings/redaction; replace only its destination.
jest.mock('pino', () => {
  const real = jest.requireActual('pino');
  /** Captures actual serialized Pino JSON without opening the configured transport. */
  return (options) => real({ ...options, transport: undefined }, {
    /** Retains fixture log bytes to verify inherited fields and duplicate keys. */
    write(line) { mockLines.push(line); },
  });
});

const NOW = Date.parse('2026-10-03T18:00:00Z');
const MARKER = `gate1-secrets-${'a'.repeat(32)}`;
const CONFIG = { schemaVersion: 1, marker: MARKER,
  startsAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 900000).toISOString() };
const UUID = '12345678-1234-4123-8123-123456789abc';
const RECORD = { event: 'gate1_secrets_probe_stage', schemaVersion: 1, authentication: 'accepted',
  observer: 'invoked_once', emission: 'header_set_returned', finalHeader: 'present', routeOutcome: 'returned', requestId: UUID };

/** Builds a selector using only synthetic arming data and a deterministic clock. */
function selector(config = CONFIG, now = NOW) {
  return createGate1SecretsTrace({ env: { GATE1_SECRETS_TRACE_JSON: JSON.stringify(config) }, now: () => now });
}

/** Marks only the exact session path; incoming IDs and private values are deliberate sentinels. */
function request() {
  return { method: 'GET', url: '/api/auth/session', headers: { 'user-agent': MARKER,
    authorization: 'credential-sentinel', cookie: 'cookie-sentinel', 'x-request-id': UUID },
  rawHeaders: ['private-raw', 'raw-sentinel'], socket: { remoteAddress: '192.0.2.40' } };
}

/** Projects only diagnostic fields from the real Pino envelope for strict validation. */
function payload() {
  const line = mockLines.find((value) => JSON.parse(value).event === 'gate1_secrets_probe_stage');
  if (!line) return null;
  const { level: _level, time: _time, pid: _pid, ...record } = JSON.parse(line);
  return record;
}

/** Load actual Production logger settings with a fixture-only output destination. */
beforeAll(() => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { jest.isolateModules(() => { ({ attachRequestLogger } = require('../../../shared/logger.js')); }); }
  finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});
beforeEach(() => { mockLines.length = 0; });

describe('private stage selection', () => {
  /** Invalid arming must stay silent and leave requests untouched. */
  it.each([undefined, '', '{', 'x'.repeat(1025), 'null', '[]'])('ignores disabled/malformed configuration (%#)', (raw) => {
    const req = request();
    expect(createGate1SecretsTrace({ env: { GATE1_SECRETS_TRACE_JSON: raw } }).start(req)).toBeUndefined();
    expect(req.log).toBeUndefined(); expect(mockLines).toEqual([]);
  });

  /** Strict arming rejects widened scope and non-UTC or excessive windows. */
  it.each([{ schemaVersion: 2 }, { extra: true }, { marker: '*' }, { marker: MARKER.toUpperCase() },
    { startsAt: '2026-10-03T18:00:00+00:00' }, { expiresAt: CONFIG.startsAt },
    { expiresAt: new Date(NOW + 900001).toISOString() }])('rejects invalid arming (%#)', (change) => {
    expect(selector({ ...CONFIG, ...change }).start(request())).toBeUndefined();
  });

  /** Start is inclusive, expiry exclusive; invalid clocks never select. */
  it.each([NOW - 1, NOW + 900000, NaN, Infinity])('refuses premature/expired clock %s', (now) => {
    expect(selector(CONFIG, now).start(request())).toBeUndefined();
  });

  /** A failed selection does not consume the slot, and normalized arrays never match. */
  it.each([{ method: 'POST' }, { url: '/api/auth/session?x=1' }, { url: '/api/auth/other' },
    { headers: { 'user-agent': [MARKER] } }, { headers: { 'user-agent': MARKER + 'x' } }, { headers: {} }])(
    'requires exact route and scalar marker (%#)', (change) => {
      const trace = selector();
      expect(trace.start({ ...request(), ...change })).toBeUndefined();
      expect(trace.start(request())).toBeDefined();
      expect(trace.start(request())).toBeUndefined();
    });

  /** One local slot cannot promise a global serverless bound. */
  it('reserves before finalization while independent loaded instances can each select', () => {
    const first = selector(), other = selector();
    expect(first.start(request())).toBeDefined(); expect(first.start(request())).toBeUndefined();
    expect(other.start(request())).toBeDefined();
  });
});

describe('private finalization and serialization', () => {
  /** Verify the actual application logger envelope, generated ID and absence of sensitive values. */
  it('serializes exactly one bounded event using the generated request binding', () => {
    const req = request(), trace = selector().start(req);
    const generated = attachRequestLogger(req);
    trace.record('authentication', 'accepted'); trace.record('invocation');
    trace.record('emission', 'header_set_returned'); trace.record('invocation'); trace.record('invocation');
    const res = { getHeader: () => 'header-value-sentinel' };
    trace.finish(req, res, 'returned'); trace.finish(req, res, 'threw'); trace.record('invocation');
    expect(mockLines).toHaveLength(1);
    expect(JSON.parse(mockLines[0]).level).toBe('info');
    expect(payload()).toEqual({ ...RECORD, requestId: generated, observer: 'invoked_multiple' });
    expect(generated).not.toBe(UUID);
    expect(parseGate1SecretsStageRecord(payload())).toEqual(payload());
    expect(Buffer.byteLength(JSON.stringify(payload()))).toBeLessThanOrEqual(1024);
    expect((mockLines[0].match(/"requestId":/g) || [])).toHaveLength(1);
    expect(Object.keys(JSON.parse(mockLines[0])).sort()).toEqual([...Object.keys(RECORD), 'level', 'time', 'pid'].sort());
    for (const value of [MARKER, UUID, 'credential-sentinel', 'cookie-sentinel', 'raw-sentinel', '192.0.2.40', 'header-value-sentinel']) {
      expect(mockLines[0]).not.toContain(value);
    }
  });

  /** Selection remains independent of raw metadata rejection and never bypasses authentication. */
  it('records the first authentication rejection without granting loader access', () => {
    const req = request(), trace = selector().start(req);
    const probe = createGate1SecretsProbe({ env: { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production',
      GATE1_SECRETS_PROBE_ENABLED: 'true', GATE1_SECRETS_PROBE_PRODUCTION_ENABLED: 'true', GATE1_SECRETS_PROBE_SECRET: 'f'.repeat(64) } });
    req.rawHeaders = ['odd'];
    expect(probe.createObserver(req, {}, trace)).toBeUndefined();
    attachRequestLogger(req);
    trace.finish(req, { getHeader: () => undefined }, 'returned');
    expect(payload()).toMatchObject({ authentication: 'raw_metadata_invalid', observer: 'not_registered', emission: 'not_attempted', finalHeader: 'absent' });
  });

  /** Registration and callback execution are distinct; final presence does not validate the header. */
  it.each(['present', 'absent', 'unavailable'])('records local final header %s', (finalHeader) => {
    const req = request(), trace = selector().start(req);
    trace.record('authentication', 'accepted'); attachRequestLogger(req);
    const res = { getHeader() { if (finalHeader === 'unavailable') throw new Error('private'); return finalHeader === 'present' ? 'invalid' : undefined; } };
    trace.finish(req, res, 'threw');
    expect(payload()).toMatchObject({ observer: 'registered_not_invoked', emission: 'not_attempted', finalHeader, routeOutcome: 'threw' });
  });

  /** Missing/untrusted logger state cannot produce an uncorrelated fallback record. */
  it.each(['missing', 'old', 'bad_id', 'extra_binding', 'bindings_throw', 'log_throw'])('contains logger failure %s', (kind) => {
    const req = request();
    if (kind === 'old') attachRequestLogger(req);
    const trace = selector().start(req);
    if (!['missing', 'old'].includes(kind)) req.log = {
      bindings() {
        if (kind === 'bindings_throw') throw new Error('private');
        return { requestId: kind === 'bad_id' ? 'raw-private' : UUID, ...(kind === 'extra_binding' ? { credential: 'private' } : {}) };
      },
      info() { throw new Error('private'); },
    };
    expect(() => trace.finish(req, {}, 'returned')).not.toThrow();
    expect(mockLines).toEqual([]);
  });

  /** Finalization discards state; another runtime's request cannot inherit its stages. */
  it('keeps overlapping instance traces isolated and suppresses events after cleanup', () => {
    const a = request(), b = request(), first = selector().start(a), second = selector().start(b);
    attachRequestLogger(a); attachRequestLogger(b);
    first.record('authentication', 'probe_disabled'); second.record('authentication', 'accepted');
    second.finish(b, {}, 'returned'); first.finish(a, {}, 'threw');
    first.record('authentication', 'accepted'); first.finish(a, {}, 'returned');
    expect(mockLines.map((line) => JSON.parse(line).authentication)).toEqual(['accepted', 'probe_disabled']);
  });
});

describe('strict sanitized record review', () => {
  /** Single-record review cannot turn duplicate/absent/unmatched logs into a diagnosis. */
  it.each([[], [RECORD, RECORD], [{ ...RECORD, requestId: '22345678-1234-4123-8123-123456789abc' }],
    [{ ...RECORD, authentication: 'probe_disabled' }], [{}], null])('rejects ambiguous record collections (%#)', (records) => {
    expect(reviewGate1SecretsStageRecords(records, UUID)).toBeNull();
    expect(reviewGate1SecretsStageRecords([RECORD], UUID)).toEqual(RECORD);
  });
  /** Reject unknown fields, contradictions, malformed IDs and oversized arbitrary text. */
  it.each([{ extra: true }, { requestId: UUID.toUpperCase() }, { event: 'other' }, { authentication: 'unknown' },
    { authentication: 'probe_disabled' }, { observer: 'not_registered' }, { observer: 'registered_not_invoked' },
    { emission: 'not_attempted' }, { finalHeader: 'x'.repeat(1025) }, { routeOutcome: 'private-error' }])(
    'leaves invalid records unresolved (%#)', (change) => {
      expect(parseGate1SecretsStageRecord({ ...RECORD, ...change })).toBeNull();
    });
});
