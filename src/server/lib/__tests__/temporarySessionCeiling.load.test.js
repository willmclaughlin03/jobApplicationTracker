import { createHmac } from 'node:crypto';
import {
  TEMPORARY_SESSION_CEILING_MAX_ADDRESSES,
  createTemporarySessionCeiling,
} from '../temporarySessionCeiling.js';

/**
 * Controlled arithmetic/load evidence for one isolated Node process.
 *
 * These tests invoke the primitive directly, so Redis, route integration,
 * deployed source trust, fleet sharing, cold starts, and GATE-1 are not tested.
 */
const LOAD_HMAC_KEY = Buffer.alloc(32, 0x2c);

/**
 * Creates deterministic crypto for repeatable single-process load profiles.
 *
 * @returns {object} Synchronous factory crypto seam.
 */
function createLoadCrypto() {
  return {
    randomBytes: () => Buffer.from(LOAD_HMAC_KEY),
    createHmac,
  };
}

/**
 * Creates one local request for a logical session or tab.
 *
 * @param {string} address - Shared or rotating source address.
 * @param {number} [logicalClient=0] - Distinct ignored cookie fixture label.
 * @returns {object} Minimal request-like load fixture.
 */
function createLoadRequest(address, logicalClient = 0) {
  return {
    cookies: { session: `load-fixture-${logicalClient}` },
    headers: {},
    rawHeaders: [],
    socket: { remoteAddress: address },
  };
}

/**
 * Produces one deterministic valid IPv4 address per cardinality index.
 *
 * @param {number} index - Zero-based source index below 16,777,216.
 * @returns {string} Unique syntactically valid IPv4 address.
 */
function addressForIndex(index) {
  const second = Math.floor(index / 65_536) % 256;
  const third = Math.floor(index / 256) % 256;
  const fourth = index % 256;
  return `10.${second}.${third}.${fourth}`;
}

/**
 * Runs one request and records only an aggregate unexpected rejection label.
 *
 * @param {object} ceiling - Isolated temporary ceiling.
 * @param {object} request - Logical session request.
 * @param {string[]} rejections - Mutable aggregate failure collector.
 * @param {string} label - Non-source load step label.
 * @returns {void}
 */
function recordUnexpectedRejection(ceiling, request, rejections, label) {
  const result = ceiling.evaluate(request, { routeVersion: 'v1' });
  if (!result.allowed) rejections.push(`${label}:${result.statusCode}`);
}

/**
 * Verifies recursively that a public snapshot contains only count values.
 *
 * @param {unknown} value - Snapshot value or nested aggregate object.
 * @returns {void}
 */
function expectCountOnly(value) {
  if (typeof value === 'number') {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    return;
  }

  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  for (const nested of Object.values(value)) expectCountOnly(nested);
}

describe('temporarySessionCeiling controlled single-process load', () => {
  it.each([1, 2, 4, 8])('allows the ten-minute %i-tab profile without rejection', (tabCount) => {
    let nowMs = 0;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createLoadCrypto(),
    });
    const requests = Array.from(
      { length: tabCount },
      (_value, tab) => createLoadRequest('198.51.100.20', tab)
    );
    const rejections = [];

    for (let tab = 0; tab < tabCount; tab += 1) {
      recordUnexpectedRejection(ceiling, requests[tab], rejections, `startup-${tab}`);
    }
    for (let elapsedSeconds = 30; elapsedSeconds <= 600; elapsedSeconds += 30) {
      nowMs = elapsedSeconds * 1000;
      for (let tab = 0; tab < tabCount; tab += 1) {
        recordUnexpectedRejection(
          ceiling,
          requests[tab],
          rejections,
          `second-${elapsedSeconds}-tab-${tab}`
        );
      }
    }

    expect(rejections).toEqual([]);
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
  });

  it('allows fifty shared-source sessions over ten minutes without rejection', () => {
    let nowMs = 0;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createLoadCrypto(),
    });
    const requests = Array.from(
      { length: 50 },
      (_value, session) => createLoadRequest('203.0.113.50', session)
    );
    const rejections = [];

    for (let session = 0; session < requests.length; session += 1) {
      recordUnexpectedRejection(
        ceiling,
        requests[session],
        rejections,
        `startup-${session}`
      );
    }
    for (let elapsedSeconds = 30; elapsedSeconds <= 600; elapsedSeconds += 30) {
      nowMs = elapsedSeconds * 1000;
      for (let session = 0; session < requests.length; session += 1) {
        recordUnexpectedRejection(
          ceiling,
          requests[session],
          rejections,
          `second-${elapsedSeconds}-session-${session}`
        );
      }
    }

    expect(rejections).toEqual([]);
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
  });

  it('actively rejects request 401 in a deliberate shared-source burst', () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 0,
      sourceMode: 'local',
      crypto: createLoadCrypto(),
    });
    const request = createLoadRequest('192.0.2.200');
    const results = [];

    for (let index = 0; index < 401; index += 1) {
      results.push(ceiling.evaluate(request, {
        routeVersion: index % 2 === 0 ? 'v1' : 'v2',
      }));
    }

    expect(results.filter((result) => result.allowed)).toHaveLength(400);
    expect(results[400]).toEqual({
      allowed: false,
      statusCode: 429,
      reason: 'limit_exceeded',
      retryAfterSeconds: 60,
    });
  });

  it('caps 10,001 rotating live sources without eviction', () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 0,
      sourceMode: 'local',
      crypto: createLoadCrypto(),
    });

    for (let index = 0; index < TEMPORARY_SESSION_CEILING_MAX_ADDRESSES; index += 1) {
      expect(ceiling.evaluate(
        createLoadRequest(addressForIndex(index), index),
        { routeVersion: 'v1' }
      )).toEqual({ allowed: true });
    }

    expect(ceiling.evaluate(
      createLoadRequest(addressForIndex(TEMPORARY_SESSION_CEILING_MAX_ADDRESSES)),
      { routeVersion: 'v2' }
    )).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'state_capacity',
    });
    expect(ceiling.getSnapshot().activeEntryCount)
      .toBe(TEMPORARY_SESSION_CEILING_MAX_ADDRESSES);
    expect(ceiling.evaluate(createLoadRequest(addressForIndex(0)), { routeVersion: 'v1' }).allowed)
      .toBe(true);
    expect(ceiling.getSnapshot().activeEntryCount)
      .toBe(TEMPORARY_SESSION_CEILING_MAX_ADDRESSES);
  });

  it('keeps high same-turn concurrency within the one-process allowance', async () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 0,
      sourceMode: 'local',
      crypto: createLoadCrypto(),
    });
    const request = createLoadRequest('192.0.2.201');
    const pending = Array.from(
      { length: 5_000 },
      () => Promise.resolve().then(() => ceiling.evaluate(request, { routeVersion: 'v1' }))
    );
    const results = await Promise.all(pending);

    expect(results.filter((result) => result.allowed)).toHaveLength(400);
    expect(results.filter((result) => result.statusCode === 429)).toHaveLength(4_600);
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
  });

  it('keeps active state bounded and snapshots count-only after mixed load', () => {
    let nowMs = 0;
    const ceiling = createTemporarySessionCeiling({
      maxAddresses: 100,
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createLoadCrypto(),
    });

    for (let index = 0; index < 100; index += 1) {
      ceiling.evaluate(createLoadRequest(addressForIndex(index)), { routeVersion: 'v1' });
    }
    nowMs = 61_000;
    ceiling.evaluate(createLoadRequest(addressForIndex(100)), { routeVersion: 'v2' });

    const snapshot = ceiling.getSnapshot();
    expect(snapshot.activeEntryCount).toBe(1);
    expect(snapshot.activeEntryCount).toBeLessThanOrEqual(100);
    expectCountOnly(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('10.');
  });
});
