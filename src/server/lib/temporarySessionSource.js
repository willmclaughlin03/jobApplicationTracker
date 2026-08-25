import { isIP } from 'node:net';

export const TEMPORARY_SESSION_SOURCE_MODES = Object.freeze({
  LOCAL: 'local',
  DEPLOYED: 'deployed',
});

const TRUSTED_HEADER_NAME = 'cloudfront-viewer-address';
const MAX_VIEWER_ADDRESS_LENGTH = 64;

/**
 * Parses canonical dotted-decimal IPv4 into its four network-order bytes.
 *
 * Why: identity framing must use address bytes rather than presentation text.
 *
 * @param {string} value validated IPv4 text
 * @returns {Buffer|null} four canonical address bytes
 */
function parseIpv4Bytes(value) {
  if (isIP(value) !== 4) return null;
  const octets = value.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return null;
  return Buffer.from(octets);
}

/**
 * Rewrites an IPv4 tail in IPv6 text into the equivalent two hexadecimal groups.
 *
 * Why: Node accepts mapped IPv6 with dotted tails, while the byte parser below
 * intentionally operates on one representation.
 *
 * @param {string} value validated IPv6 text
 * @returns {string|null} hexadecimal-only IPv6 text
 */
function replaceIpv4Tail(value) {
  if (!value.includes('.')) return value;
  const separatorIndex = value.lastIndexOf(':');
  if (separatorIndex < 0) return null;
  const ipv4 = parseIpv4Bytes(value.slice(separatorIndex + 1));
  if (!ipv4) return null;
  const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
  const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
  return `${value.slice(0, separatorIndex + 1)}${high}:${low}`;
}

/**
 * Expands validated IPv6 text into sixteen network-order bytes.
 *
 * Why: equivalent compressed spellings must consume the same Redis allowance.
 *
 * @param {string} value validated IPv6 text
 * @returns {Buffer|null} sixteen canonical address bytes
 */
function parseIpv6Bytes(value) {
  if (isIP(value) !== 6 || value.includes('%')) return null;
  const hexadecimal = replaceIpv4Tail(value.toLowerCase());
  if (!hexadecimal) return null;

  const compressionParts = hexadecimal.split('::');
  if (compressionParts.length > 2) return null;
  const left = compressionParts[0] ? compressionParts[0].split(':') : [];
  const right = compressionParts.length === 2 && compressionParts[1]
    ? compressionParts[1].split(':')
    : [];
  const groupPattern = /^[0-9a-f]{1,4}$/;
  if ([...left, ...right].some((group) => !groupPattern.test(group))) return null;

  const omittedGroupCount = 8 - left.length - right.length;
  if ((compressionParts.length === 1 && omittedGroupCount !== 0)
    || (compressionParts.length === 2 && omittedGroupCount < 1)) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: omittedGroupCount }, () => '0'),
    ...right,
  ];
  if (groups.length !== 8) return null;

  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

/**
 * Detects the RFC 4291 IPv4-mapped IPv6 byte prefix.
 *
 * Why: native and mapped IPv4 forms must share one coarse-source budget.
 *
 * @param {Buffer} bytes sixteen canonical IPv6 bytes
 * @returns {boolean} whether the address embeds IPv4 in the mapped prefix
 */
function isIpv4Mapped(bytes) {
  return bytes.length === 16
    && bytes.subarray(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
}

/**
 * Canonicalizes one address without retaining its textual representation.
 *
 * Why: raw and canonical source text must remain transient and must never enter
 * state keys, errors, telemetry, or response output.
 *
 * @param {unknown} value candidate source address
 * @returns {{family: 4|6, addressBytes: Buffer}|null} canonical byte identity
 */
export function canonicalizeTemporarySessionAddress(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 45 || value !== value.trim()) {
    return null;
  }

  const ipv4Bytes = parseIpv4Bytes(value);
  if (ipv4Bytes) return { family: 4, addressBytes: ipv4Bytes };

  const ipv6Bytes = parseIpv6Bytes(value);
  if (!ipv6Bytes) return null;
  if (isIpv4Mapped(ipv6Bytes)) {
    return { family: 4, addressBytes: Buffer.from(ipv6Bytes.subarray(12)) };
  }
  return { family: 6, addressBytes: ipv6Bytes };
}

/**
 * Parses a strict non-zero decimal TCP source port.
 *
 * Why: leading zeroes, omitted ports, and out-of-range values make the trusted
 * CloudFront serialization ambiguous and therefore fail closed.
 *
 * @param {unknown} value candidate decimal port text
 * @returns {number|null} validated port
 */
function parseSourcePort(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port <= 65_535 ? port : null;
}

/**
 * Parses the approved CloudFront-Viewer-Address serialization.
 *
 * Why: deployed IPv4 requires `address:port` and IPv6 requires
 * `[address]:port`; no forwarding-header or socket fallback is permitted.
 *
 * @param {unknown} value exact singleton raw-header value
 * @returns {{family: 4|6, addressBytes: Buffer}|null} canonical byte identity
 */
export function parseTemporarySessionViewerAddress(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_VIEWER_ADDRESS_LENGTH
    || value !== value.trim()
    || value.includes(',')) {
    return null;
  }

  const ipv4Match = /^((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/.exec(value);
  if (ipv4Match) {
    return parseSourcePort(ipv4Match[2]) === null
      ? null
      : canonicalizeTemporarySessionAddress(ipv4Match[1]);
  }

  const ipv6Match = /^\[([^\]]+)\]:([1-9]\d{0,4})$/.exec(value);
  if (!ipv6Match || parseSourcePort(ipv6Match[2]) === null || isIP(ipv6Match[1]) !== 6) {
    return null;
  }
  return canonicalizeTemporarySessionAddress(ipv6Match[1]);
}

/**
 * Reads one exact raw-header occurrence and rejects malformed raw metadata.
 *
 * Why: normalized Node headers cannot prove a trusted header occurred once.
 *
 * @param {object} req Next.js request-like object
 * @returns {string|null} exact singleton trusted-header value
 */
function readSingleTrustedRawHeader(req) {
  const rawHeaders = req?.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;

  let count = 0;
  let matchedValue = null;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') return null;
    if (name.toLowerCase() !== TRUSTED_HEADER_NAME) continue;
    count += 1;
    matchedValue = value;
  }
  return count === 1 ? matchedValue : null;
}

/**
 * Resolves and validates the configured source trust policy.
 *
 * Why: production must explicitly select the deployed CloudFront boundary;
 * local/test execution may select a socket-only fixture policy.
 *
 * @param {object} [options] explicit mode and environment seams
 * @param {unknown} [options.mode] explicitly injected mode
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} [options.env] environment snapshot
 * @returns {'local'|'deployed'|null} validated policy
 */
export function resolveTemporarySessionSourceMode(options = {}) {
  const env = options.env ?? process.env;
  const nodeEnvironment = env?.NODE_ENV;
  const configured = options.mode ?? env?.TEMPORARY_SESSION_CEILING_SOURCE_MODE
    ?? ((nodeEnvironment === 'test' || nodeEnvironment === 'development') ? 'local' : undefined);
  if (!Object.values(TEMPORARY_SESSION_SOURCE_MODES).includes(configured)) return null;
  if (nodeEnvironment === 'production' && configured !== TEMPORARY_SESSION_SOURCE_MODES.DEPLOYED) {
    return null;
  }
  return configured;
}

/**
 * Resolves a source using only the selected explicit trust boundary.
 *
 * Why: forwarding headers are caller-controlled and deployed origin sockets
 * describe the proxy rather than the viewer, so neither is a valid fallback.
 *
 * @param {object} req Next.js request-like object
 * @param {'local'|'deployed'} mode validated source mode
 * @returns {{family: 4|6, addressBytes: Buffer}|null} canonical byte identity
 */
export function resolveTemporarySessionSource(req, mode) {
  if (mode === TEMPORARY_SESSION_SOURCE_MODES.LOCAL) {
    return canonicalizeTemporarySessionAddress(req?.socket?.remoteAddress);
  }
  if (mode !== TEMPORARY_SESSION_SOURCE_MODES.DEPLOYED) return null;

  const rawValue = readSingleTrustedRawHeader(req);
  const normalizedValue = req?.headers?.[TRUSTED_HEADER_NAME];
  if (rawValue === null || typeof normalizedValue !== 'string' || normalizedValue !== rawValue) {
    return null;
  }
  return parseTemporarySessionViewerAddress(rawValue);
}
