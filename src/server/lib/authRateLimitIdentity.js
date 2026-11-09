import { createHmac } from 'node:crypto';
import { safeUserSchema } from '../../shared/schemas/authV2.js';
import { authRateLimitOperationSchema } from './authRateLimitPolicy.js';
import { decodeTemporarySessionHmacKey } from './temporarySessionIdentity.js';
import { parseTemporarySessionHmacSecret } from './temporarySessionSecrets.js';

export const AUTH_RATE_LIMIT_HMAC_DOMAIN = 'auth-rate-limit:v1';
export const AUTH_RATE_LIMIT_REDIS_NAMESPACE = 'arl:v1';

/**
 * Frames bounded bytes with a uint32 byte length to prevent concatenation aliases.
 * @param {Buffer|string} value internal identity field; never logged
 * @returns {Buffer} length followed by bytes
 */
function frameField(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * Derives one internal operation/user-or-source HMAC key, reusing reviewed key validation.
 * AUTH_SESSION requires a caller-authenticated SafeUser, never a cookie/JWT claim.
 * Rotation configurations fail closed until hourly/daily continuity is designed.
 * @param {object} input operation and either authenticatedUser or canonical source
 * @param {object} keyring deployment-bound HMAC snapshot
 * @returns {string} internal Redis key; no identifiers may enter public results/logs
 */
export function deriveAuthRateLimitIdentity(input, keyring) {
  try {
    const operation = authRateLimitOperationSchema.parse(input?.operation);
    const hmac = parseTemporarySessionHmacSecret(keyring);
    if (hmac.previous !== null) throw new Error();
    const { active } = hmac;
    const generation = Buffer.alloc(4);
    generation.writeUInt32BE(active.generation);
    let subject;
    let kind;
    if (operation === 'AUTH_SESSION') {
      const user = safeUserSchema.parse(input.authenticatedUser);
      kind = 0;
      subject = Buffer.from(user.id.toLowerCase(), 'utf8');
    } else {
      const source = input.source;
      kind = source?.family;
      if ((kind !== 4 && kind !== 6) || !Buffer.isBuffer(source?.addressBytes)
        || source.addressBytes.length !== (kind === 4 ? 4 : 16)) throw new Error();
      subject = source.addressBytes;
    }
    const frame = Buffer.concat([
      Buffer.from([1]), frameField(AUTH_RATE_LIMIT_HMAC_DOMAIN), generation,
      frameField(active.keyId), frameField(operation), Buffer.from([kind]), frameField(subject),
    ]);
    const digest = createHmac('sha256', decodeTemporarySessionHmacKey(active.key))
      .update(frame).digest('base64url');
    return `${AUTH_RATE_LIMIT_REDIS_NAMESPACE}:${operation}:${digest}`;
  } catch {
    throw new Error('auth rate limit identity unavailable');
  }
}
