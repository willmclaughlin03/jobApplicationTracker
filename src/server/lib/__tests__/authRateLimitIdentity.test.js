import { createHmac } from 'node:crypto';
import { deriveAuthRateLimitIdentity } from '../authRateLimitIdentity.js';
import { deriveTemporarySessionIdentity } from '../temporarySessionIdentity.js';
import { canonicalizeTemporarySessionAddress } from '../temporarySessionSource.js';

const keyring = {
  schemaVersion: 1,
  active: { generation: 1, keyId: 'synthetic-key', key: Buffer.alloc(32, 7).toString('base64url') },
  previous: null,
};
const user = { id: '9e798a6c-3a93-4c15-bc6a-6dbf76f47a40', email: null, role: 'user' };

/** Builds a synthetic canonical source through the actual reviewed parser. */
function sourceInput(address = '192.0.2.10', operation = 'PRE_AUTH') {
  return { operation, source: canonicalizeTemporarySessionAddress(address) };
}

/** Verifies framing, operation separation, and safe rejection without credentials. */
describe('authRateLimitIdentity', () => {
  it('freezes independent byte framing for a trusted-source identity', () => {
    const bytes = [];
    /** Independently appends one uint32-length UTF-8 or binary test field. */
    function append(value) {
      const buffer = Buffer.from(value);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(buffer.length);
      bytes.push(length, buffer);
    }
    bytes.push(Buffer.from([1]));
    append('auth-rate-limit:v1');
    bytes.push(Buffer.from([0, 0, 0, 1]));
    append('synthetic-key');
    append('PRE_AUTH');
    bytes.push(Buffer.from([4]));
    append(Buffer.from([192, 0, 2, 10]));
    const digest = createHmac('sha256', Buffer.alloc(32, 7)).update(Buffer.concat(bytes)).digest('base64url');
    expect(deriveAuthRateLimitIdentity(sourceInput(), keyring)).toBe(`arl:v1:PRE_AUTH:${digest}`);
  });
  it.each([
    ['192.0.2.10', '::ffff:192.0.2.10'],
    ['2001:db8::1', '2001:0db8:0:0:0:0:0:0001'],
  ])('preserves canonical equivalence for %s / %s', (left, right) => {
    expect(deriveAuthRateLimitIdentity(sourceInput(left), keyring))
      .toBe(deriveAuthRateLimitIdentity(sourceInput(right), keyring));
  });
  it('separates every public operation and the existing temporary ceiling', () => {
    const identities = ['PRE_AUTH', 'AUTH_LOGOUT', 'AUTH_FAILURE', 'AUTH_CALLBACK']
      .map((operation) => deriveAuthRateLimitIdentity(sourceInput('192.0.2.10', operation), keyring));
    expect(new Set(identities.map((key) => key.split(':').at(-1))).size).toBe(4);
    expect(identities).not.toContain(deriveTemporarySessionIdentity(sourceInput().source, keyring.active).redisKey);
    for (const key of identities) {
      expect(key).not.toContain('192.0.2.10');
      expect(key).not.toContain(keyring.active.keyId);
      expect(key.length).toBeLessThan(80);
    }
  });
  it('uses the authenticated UUID alone, with stable case and no role/email/tier split', () => {
    const identity = deriveAuthRateLimitIdentity({ operation: 'AUTH_SESSION', authenticatedUser: user }, keyring);
    expect(deriveAuthRateLimitIdentity({ operation: 'AUTH_SESSION', authenticatedUser: {
      ...user, id: user.id.toUpperCase(), email: 'synthetic@example.invalid', role: 'admin',
    } }, keyring)).toBe(identity);
    expect(identity).not.toContain(user.id);
    expect(deriveAuthRateLimitIdentity({ operation: 'AUTH_SESSION', authenticatedUser: {
      ...user, id: '9e798a6c-3a93-4c15-bc6a-6dbf76f47a41',
    } }, keyring)).not.toBe(identity);
  });
  it('separates generation, key ID, material, and source', () => {
    const baseline = deriveAuthRateLimitIdentity(sourceInput(), keyring);
    for (const change of [{ generation: 2 }, { keyId: 'synthetic-other' }, { key: Buffer.alloc(32, 8).toString('base64url') }]) {
      expect(deriveAuthRateLimitIdentity(sourceInput(), {
        ...keyring, active: { ...keyring.active, ...change },
      })).not.toBe(baseline);
    }
    expect(deriveAuthRateLimitIdentity(sourceInput('192.0.2.11'), keyring)).not.toBe(baseline);
  });
  it.each([
    null, { operation: 'AUTH_SESSION' }, { operation: 'AUTH_SESSION', session_id: user.id },
    { operation: 'AUTH_SESSION', authenticatedUser: { ...user, id: 'raw-secret' } },
    { operation: 'AUTH_SESSION', authenticatedUser: { ...user, extra: true } },
    { operation: 'PRE_AUTH', source: { family: 4, addressBytes: Buffer.alloc(16) } },
    { operation: 'PRE_AUTH', source: { family: 9, addressBytes: Buffer.alloc(4) } },
    { operation: 'AUTH', source: sourceInput().source },
  ])('sanitizes malformed identity %p', (input) => {
    expect(() => deriveAuthRateLimitIdentity(input, keyring)).toThrow('auth rate limit identity unavailable');
  });
  it.each([
    null,
    { ...keyring, active: { ...keyring.active, key: 'secret-sentinel' } },
    { ...keyring, active: { ...keyring.active, generation: 3 } },
    { ...keyring, active: { ...keyring.active, keyId: 'bad\nkey' } },
    { ...keyring, active: { ...keyring.active, generation: 2 }, previous: {
      ...keyring.active, keyId: 'old', key: Buffer.alloc(32, 8).toString('base64url'),
    } },
  ])('rejects invalid or rotating configuration without exposing material', (ring) => {
    expect(() => deriveAuthRateLimitIdentity(sourceInput(), ring)).toThrow('auth rate limit identity unavailable');
  });
});
