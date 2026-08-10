import {
  TEMPORARY_SESSION_CEILING_MAX_ADDRESSES,
  createTemporarySessionCeiling,
} from '../temporarySessionCeiling.js';

/**
 * Creates a local session request for a controlled load profile.
 *
 * @param {string} address - Shared or rotating source address.
 * @returns {object} Minimal request surface used by the ceiling.
 */
function createLoadRequest(address) {
  return {
    cookies: {},
    headers: {},
    socket: { remoteAddress: address },
  };
}

/**
 * Produces deterministic valid IPv4 addresses for cardinality testing.
 *
 * @param {number} index - Zero-based source index.
 * @returns {string} Valid unique IPv4 address.
 */
function addressForIndex(index) {
  const second = Math.floor(index / 65_536) % 256;
  const third = Math.floor(index / 256) % 256;
  const fourth = index % 256;
  return `10.${second}.${third}.${fourth}`;
}

/**
 * Executes one session check and records an unexpected rejection.
 *
 * @param {object} ceiling - Temporary ceiling instance.
 * @param {object} request - Shared-IP request.
 * @param {string[]} rejections - Mutable failure collector.
 * @param {string} label - Load-step description.
 * @returns {void}
 */
function expectAllowed(ceiling, request, rejections, label) {
  const result = ceiling.evaluate(request, { routeVersion: 'v1' });
  if (!result.allowed) rejections.push(`${label}:${result.statusCode}`);
}

describe('temporarySessionCeiling controlled load', () => {
  it.each([1, 2, 4, 8])('allows the ten-minute %i-tab profile without rejection', (tabCount) => {
    let nowMs = 0;
    const ceiling = createTemporarySessionCeiling({ now: () => nowMs, sourceMode: 'local' });
    const request = createLoadRequest('198.51.100.20');
    const rejections = [];

    for (let tab = 0; tab < tabCount; tab += 1) {
      expectAllowed(ceiling, request, rejections, `startup-${tab}`);
    }

    for (let elapsedSeconds = 30; elapsedSeconds <= 600; elapsedSeconds += 30) {
      nowMs = elapsedSeconds * 1000;
      for (let tab = 0; tab < tabCount; tab += 1) {
        expectAllowed(ceiling, request, rejections, `second-${elapsedSeconds}-tab-${tab}`);
      }
    }

    expect(rejections).toEqual([]);
  });

  it('allows fifty shared-IP sessions for ten minutes without rejection', () => {
    let nowMs = 0;
    const ceiling = createTemporarySessionCeiling({ now: () => nowMs, sourceMode: 'local' });
    const request = createLoadRequest('203.0.113.50');
    const rejections = [];

    for (let session = 0; session < 50; session += 1) {
      expectAllowed(ceiling, request, rejections, `startup-${session}`);
    }

    for (let elapsedSeconds = 30; elapsedSeconds <= 600; elapsedSeconds += 30) {
      nowMs = elapsedSeconds * 1000;
      for (let session = 0; session < 50; session += 1) {
        expectAllowed(ceiling, request, rejections, `second-${elapsedSeconds}-session-${session}`);
      }
    }

    expect(rejections).toEqual([]);
  });

  it('actively rejects request 401 in a deliberate shared-IP overload', () => {
    const ceiling = createTemporarySessionCeiling({ now: () => 0, sourceMode: 'local' });
    const request = createLoadRequest('192.0.2.200');

    for (let index = 0; index < 400; index += 1) {
      expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    }

    expect(ceiling.evaluate(request, { routeVersion: 'v2' })).toEqual({
      allowed: false,
      statusCode: 429,
      reason: 'limit_exceeded',
      retryAfterSeconds: 60,
    });
  });

  it('never exceeds 10,000 entries under rotating-source load', () => {
    const ceiling = createTemporarySessionCeiling({ now: () => 0, sourceMode: 'local' });

    for (let index = 0; index < TEMPORARY_SESSION_CEILING_MAX_ADDRESSES; index += 1) {
      expect(ceiling.evaluate(createLoadRequest(addressForIndex(index)), { routeVersion: 'v1' }))
        .toEqual({ allowed: true });
    }

    expect(ceiling.evaluate(
      createLoadRequest(addressForIndex(TEMPORARY_SESSION_CEILING_MAX_ADDRESSES)),
      { routeVersion: 'v1' }
    )).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'state_capacity',
    });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(TEMPORARY_SESSION_CEILING_MAX_ADDRESSES);
  });
});
