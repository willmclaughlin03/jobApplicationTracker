import {
  buildTemporarySessionHmacFrame,
  decodeTemporarySessionHmacKey,
  deriveTemporarySessionIdentity,
  TEMPORARY_SESSION_HMAC_DOMAIN,
  TEMPORARY_SESSION_HMAC_OPERATION,
} from '../temporarySessionIdentity.js';

const ACTIVE_KEY = Buffer.alloc(32, 1).toString('base64url');
const ACTIVE_ENTRY = Object.freeze({ generation: 1, keyId: 'gate1-key-1', key: ACTIVE_KEY });
const IPV4_SOURCE = Object.freeze({ family: 4, addressBytes: Buffer.from([192, 0, 2, 70]) });
const ORIGINAL_BUILD_ID = process.env.NEXT_BUILD_ID;

/**
 * Encodes one UTF-8 test field with the production unsigned length prefix.
 *
 * @param {string} value synthetic field
 * @returns {Buffer} framed bytes
 */
function frameText(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

describe('temporarySessionIdentity', () => {
  afterEach(() => {
    if (ORIGINAL_BUILD_ID === undefined) delete process.env.NEXT_BUILD_ID;
    else process.env.NEXT_BUILD_ID = ORIGINAL_BUILD_ID;
  });

  it('accepts only canonical unpadded 32-byte base64url keys', () => {
    expect(decodeTemporarySessionHmacKey(ACTIVE_KEY)).toEqual(Buffer.alloc(32, 1));
    expect(() => decodeTemporarySessionHmacKey(`${ACTIVE_KEY}=`)).toThrow(
      'temporary session identity configuration is invalid'
    );
    expect(() => decodeTemporarySessionHmacKey(Buffer.alloc(31, 1).toString('base64url'))).toThrow();
    expect(() => decodeTemporarySessionHmacKey('!'.repeat(43))).toThrow();
  });

  it('freezes the exact versioned, length-framed byte order', () => {
    const generation = Buffer.alloc(4);
    generation.writeUInt32BE(1);
    const addressLength = Buffer.alloc(4);
    addressLength.writeUInt32BE(4);
    const expected = Buffer.concat([
      Buffer.from([1]),
      frameText(TEMPORARY_SESSION_HMAC_DOMAIN),
      generation,
      frameText('gate1-key-1'),
      frameText(TEMPORARY_SESSION_HMAC_OPERATION),
      Buffer.from([4]),
      addressLength,
      Buffer.from([192, 0, 2, 70]),
    ]);
    expect(buildTemporarySessionHmacFrame(IPV4_SOURCE, ACTIVE_ENTRY)).toEqual(expected);
  });

  it('produces stable identity across unrelated build context', () => {
    const first = deriveTemporarySessionIdentity(IPV4_SOURCE, ACTIVE_ENTRY);
    process.env.NEXT_BUILD_ID = 'synthetic-build-b';
    const second = deriveTemporarySessionIdentity(IPV4_SOURCE, ACTIVE_ENTRY);
    expect(second.redisKey === first.redisKey).toBe(true);
    expect(/^tsc:v1:g1:gate1-key-1:[A-Za-z0-9_-]{43}$/.test(first.redisKey)).toBe(true);
  });

  it('separates source fields and keyring generations without delimiter collisions', () => {
    const first = deriveTemporarySessionIdentity(IPV4_SOURCE, ACTIVE_ENTRY);
    const nextSource = { family: 4, addressBytes: Buffer.from([192, 0, 2, 71]) };
    const nextGeneration = { ...ACTIVE_ENTRY, generation: 2, keyId: 'gate1-key-2' };
    expect(deriveTemporarySessionIdentity(nextSource, ACTIVE_ENTRY).redisKey === first.redisKey).toBe(false);
    expect(deriveTemporarySessionIdentity(IPV4_SOURCE, nextGeneration).redisKey === first.redisKey).toBe(false);
    expect(buildTemporarySessionHmacFrame(IPV4_SOURCE, ACTIVE_ENTRY)).not.toEqual(
      buildTemporarySessionHmacFrame({ family: 6, addressBytes: Buffer.alloc(16) }, ACTIVE_ENTRY)
    );
  });

  it('returns sanitized errors when source or crypto is unavailable', () => {
    expect(() => deriveTemporarySessionIdentity(
      { family: 4, addressBytes: Buffer.alloc(3) },
      ACTIVE_ENTRY
    )).toThrow('temporary session identity source is invalid');
    expect(() => deriveTemporarySessionIdentity(IPV4_SOURCE, ACTIVE_ENTRY, {
      createHmacFunction: () => ({ update: () => {}, digest: () => Buffer.alloc(2) }),
    })).toThrow('temporary session identity is unavailable');
  });
});
