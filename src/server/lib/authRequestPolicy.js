/**
 * Exact request-intent policies for future v2 authentication routes.
 *
 * Purpose: Reject ambiguous custom headers using both Node's normalized and
 * raw header views before a route performs any provider or mutation work.
 * Connects to: X-App-Request and X-Logout-Intent shared contract constants.
 */

import {
  APP_REQUEST_HEADER,
  APP_REQUEST_VALUE,
  LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_VALUE,
} from '../../shared/constants/authV2.js';

export const AUTH_REQUEST_POLICY_REASONS = Object.freeze({
  ACCEPTED: 'accepted',
  MISSING: 'missing',
  DUPLICATE: 'duplicate',
  ARRAY_VALUE: 'array_value',
  INVALID_VALUE: 'invalid_value',
  REPRESENTATION_MISMATCH: 'representation_mismatch',
  MALFORMED: 'malformed',
});

/**
 * Creates a fixed-shape decision that never includes a supplied header value.
 *
 * @param {boolean} accepted whether the exact header policy passed
 * @param {string} reason fixed decision reason
 * @returns {{accepted: boolean, reason: string}} bounded policy decision
 */
function createPolicyDecision(accepted, reason) {
  return { accepted, reason };
}

/**
 * Collects one case-insensitive header from Node's normalized header object.
 * Duplicate casing, arrays, and malformed containers remain distinguishable.
 *
 * @param {unknown} headers normalized request headers
 * @param {string} expectedName expected header name
 * @returns {object} bounded normalized-header observation
 */
function inspectNormalizedHeader(headers, expectedName) {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return { kind: AUTH_REQUEST_POLICY_REASONS.MALFORMED };
  }

  const names = Object.keys(headers).filter(
    (name) => name.toLowerCase() === expectedName.toLowerCase()
  );
  if (names.length === 0) return { kind: AUTH_REQUEST_POLICY_REASONS.MISSING };
  if (names.length > 1) return { kind: AUTH_REQUEST_POLICY_REASONS.DUPLICATE };

  const value = headers[names[0]];
  if (Array.isArray(value)) return { kind: AUTH_REQUEST_POLICY_REASONS.ARRAY_VALUE };
  if (typeof value !== 'string') return { kind: AUTH_REQUEST_POLICY_REASONS.MALFORMED };
  return { kind: 'present', value };
}

/**
 * Collects one case-insensitive header from Node's alternating rawHeaders list.
 * The complete list must contain well-formed string name/value pairs.
 *
 * @param {unknown} rawHeaders raw Node request headers
 * @param {string} expectedName expected header name
 * @returns {object} bounded raw-header observation
 */
function inspectRawHeader(rawHeaders, expectedName) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    return { kind: AUTH_REQUEST_POLICY_REASONS.MALFORMED };
  }

  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') {
      return { kind: AUTH_REQUEST_POLICY_REASONS.MALFORMED };
    }
    if (name.toLowerCase() === expectedName.toLowerCase()) values.push(value);
  }

  if (values.length === 0) return { kind: AUTH_REQUEST_POLICY_REASONS.MISSING };
  if (values.length > 1) return { kind: AUTH_REQUEST_POLICY_REASONS.DUPLICATE };
  return { kind: 'present', value: values[0] };
}

/**
 * Evaluates one exact intent header across normalized and raw representations.
 * Only a single identical string value in both views is accepted.
 *
 * @param {unknown} request Node/Next request candidate
 * @param {string} expectedName exact contract header name
 * @param {string} expectedValue exact contract header value
 * @returns {{accepted: boolean, reason: string}} bounded policy decision
 */
function evaluateIntentHeader(request, expectedName, expectedValue) {
  try {
    if (typeof request !== 'object' || request === null) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.MALFORMED);
    }

    const normalized = inspectNormalizedHeader(request.headers, expectedName);
    const raw = inspectRawHeader(request.rawHeaders, expectedName);
    if (normalized.kind === AUTH_REQUEST_POLICY_REASONS.MALFORMED
      || raw.kind === AUTH_REQUEST_POLICY_REASONS.MALFORMED) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.MALFORMED);
    }
    if (normalized.kind === AUTH_REQUEST_POLICY_REASONS.DUPLICATE
      || raw.kind === AUTH_REQUEST_POLICY_REASONS.DUPLICATE) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.DUPLICATE);
    }
    if (normalized.kind === AUTH_REQUEST_POLICY_REASONS.ARRAY_VALUE) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.ARRAY_VALUE);
    }
    if (normalized.kind !== raw.kind) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.REPRESENTATION_MISMATCH);
    }
    if (normalized.kind === AUTH_REQUEST_POLICY_REASONS.MISSING) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.MISSING);
    }
    if (normalized.value !== raw.value) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.REPRESENTATION_MISMATCH);
    }
    if (normalized.value !== expectedValue) {
      return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.INVALID_VALUE);
    }
    return createPolicyDecision(true, AUTH_REQUEST_POLICY_REASONS.ACCEPTED);
  } catch {
    return createPolicyDecision(false, AUTH_REQUEST_POLICY_REASONS.MALFORMED);
  }
}

/**
 * Evaluates the exact application-request intent required by v2 session work.
 *
 * @param {unknown} request Node/Next request candidate
 * @returns {{accepted: boolean, reason: string}} bounded policy decision
 */
export function evaluateAppRequestPolicy(request) {
  return evaluateIntentHeader(request, APP_REQUEST_HEADER, APP_REQUEST_VALUE);
}

/**
 * Evaluates only the exact logout-intent header; later logout work separately
 * owns method, body, same-origin proof, and cleanup ordering.
 *
 * @param {unknown} request Node/Next request candidate
 * @returns {{accepted: boolean, reason: string}} bounded policy decision
 */
export function evaluateLogoutIntentPolicy(request) {
  return evaluateIntentHeader(request, LOGOUT_INTENT_HEADER, LOGOUT_INTENT_VALUE);
}
