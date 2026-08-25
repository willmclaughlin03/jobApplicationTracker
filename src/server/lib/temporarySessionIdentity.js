import { createHmac } from 'node:crypto';

export const TEMPORARY_SESSION_HMAC_FRAME_VERSION = 1;
export const TEMPORARY_SESSION_HMAC_DOMAIN = 'temporary-session-ceiling:v1';
export const TEMPORARY_SESSION_HMAC_OPERATION = 'auth-session-coarse-source';
export const TEMPORARY_SESSION_REDIS_NAMESPACE = 'tsc:v1';
export const TEMPORARY_SESSION_MAX_GENERATION = 0xffff_ffff;
export const TEMPORARY_SESSION_KEY_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;

const CANONICAL_HMAC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Decodes one canonical unpadded-base64url HMAC key.
 *
 * Why: accepting padded, aliased, or wrong-length material would make rotation
 * metadata ambiguous and could weaken the stable cross-instance identity.
 *
 * @param {unknown} value candidate encoded key
 * @returns {Buffer} exactly 32 decoded bytes
 * @throws {Error} when the key is not canonical
 */
export function decodeTemporarySessionHmacKey(value) {
  if (typeof value !== 'string' || !CANONICAL_HMAC_KEY_PATTERN.test(value)) {
    throw new Error('temporary session identity configuration is invalid');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    throw new Error('temporary session identity configuration is invalid');
  }
  return bytes;
}

/**
 * Encodes a bounded UTF-8 field with an unsigned 32-bit byte length.
 *
 * Why: explicit byte lengths prevent boundary collisions between adjacent
 * identity fields without relying on delimiter escaping.
 *
 * @param {string} value bounded identity field
 * @returns {Buffer} length-prefixed UTF-8 bytes
 */
function encodeLengthFramedUtf8(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/**
 * Encodes a bounded byte field with an unsigned 32-bit byte length.
 *
 * Why: source-address bytes use the same reviewed framing rule as text fields.
 *
 * @param {Buffer} bytes canonical address bytes
 * @returns {Buffer} length-prefixed bytes
 */
function encodeLengthFramedBytes(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/**
 * Validates the application-owned HMAC generation and key identifier.
 *
 * Why: generation and key ID become part of the Redis namespace and therefore
 * must remain bounded printable values selected by trusted configuration.
 *
 * @param {object} keyEntry validated keyring entry candidate
 * @returns {void}
 * @throws {Error} when metadata is outside the frozen bounds
 */
function validateKeyMetadata(keyEntry) {
  if (!keyEntry
    || !Number.isSafeInteger(keyEntry.generation)
    || keyEntry.generation < 1
    || keyEntry.generation > TEMPORARY_SESSION_MAX_GENERATION
    || typeof keyEntry.keyId !== 'string'
    || !TEMPORARY_SESSION_KEY_ID_PATTERN.test(keyEntry.keyId)) {
    throw new Error('temporary session identity configuration is invalid');
  }
}

/**
 * Builds the frozen HMAC byte frame for one canonical source.
 *
 * Frame order: version byte, framed domain, uint32 generation, framed key ID,
 * framed operation, family byte, and framed canonical address bytes. Route,
 * build, deployment, bundle, and module-boot identity are intentionally absent.
 *
 * @param {{family: 4|6, addressBytes: Buffer}} source transient canonical source
 * @param {{generation: number, keyId: string}} keyEntry active key metadata
 * @returns {Buffer} unambiguous HMAC input frame
 * @throws {Error} when source or key metadata is malformed
 */
export function buildTemporarySessionHmacFrame(source, keyEntry) {
  validateKeyMetadata(keyEntry);
  const expectedAddressLength = source?.family === 4 ? 4 : source?.family === 6 ? 16 : 0;
  if (!Buffer.isBuffer(source?.addressBytes) || source.addressBytes.length !== expectedAddressLength) {
    throw new Error('temporary session identity source is invalid');
  }

  const version = Buffer.from([TEMPORARY_SESSION_HMAC_FRAME_VERSION]);
  const generation = Buffer.alloc(4);
  generation.writeUInt32BE(keyEntry.generation, 0);
  const family = Buffer.from([source.family]);

  return Buffer.concat([
    version,
    encodeLengthFramedUtf8(TEMPORARY_SESSION_HMAC_DOMAIN),
    generation,
    encodeLengthFramedUtf8(keyEntry.keyId),
    encodeLengthFramedUtf8(TEMPORARY_SESSION_HMAC_OPERATION),
    family,
    encodeLengthFramedBytes(source.addressBytes),
  ]);
}

/**
 * Derives the stable, generation-scoped Redis key for one source.
 *
 * Why: only HMAC output reaches Redis; raw/canonical addresses and standalone
 * digests are never returned through errors or telemetry.
 *
 * @param {{family: 4|6, addressBytes: Buffer}} source transient canonical source
 * @param {{generation: number, keyId: string, key: string}} keyEntry active key
 * @param {object} [options] deterministic cryptography seam
 * @param {Function} [options.createHmacFunction] Node-compatible HMAC creator
 * @returns {{redisKey: string, generation: number, keyId: string}} internal identity
 * @throws {Error} when framing or cryptography is unavailable
 */
export function deriveTemporarySessionIdentity(source, keyEntry, options = {}) {
  const createHmacFunction = options.createHmacFunction ?? createHmac;
  if (typeof createHmacFunction !== 'function') {
    throw new Error('temporary session identity is unavailable');
  }

  const keyBytes = decodeTemporarySessionHmacKey(keyEntry?.key);
  const frame = buildTemporarySessionHmacFrame(source, keyEntry);
  const hmac = createHmacFunction('sha256', keyBytes);
  if (!hmac || typeof hmac.update !== 'function' || typeof hmac.digest !== 'function') {
    throw new Error('temporary session identity is unavailable');
  }
  hmac.update(frame);
  const digestBytes = hmac.digest();
  if (!Buffer.isBuffer(digestBytes) || digestBytes.length !== 32) {
    throw new Error('temporary session identity is unavailable');
  }
  const digest = digestBytes.toString('base64url');
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error('temporary session identity is unavailable');
  }

  return {
    redisKey: `${TEMPORARY_SESSION_REDIS_NAMESPACE}:g${keyEntry.generation}:${keyEntry.keyId}:${digest}`,
    generation: keyEntry.generation,
    keyId: keyEntry.keyId,
  };
}
