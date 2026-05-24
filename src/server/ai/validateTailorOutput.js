/**
 * Validates raw text output from Claude against the TailorResponse schema.
 *
 * Purpose: Belt-and-suspenders check between Claude's response and the rest
 *          of the handler. Catches schema drift, XSS payloads injected via
 *          the JD, and credential exfiltration attempts.
 *
 * Never throws — always returns the success/failure union so the Phase 2
 * handler can cleanly switch on `valid` without a try/catch.
 *
 * Base64 detection is LOG-ONLY in Phase 0 (returns valid: true with a warning).
 * Phase 4 will review the false-positive rate from Axiom and decide whether
 * to promote it to a hard reject.
 *
 * Connected to:
 *   src/shared/schemas/profile.js        — TailorResponse schema
 *   src/server/ai/extractTextContent.js  — upstream: provides rawText
 *   src/pages/api/jobs/[id]/tailor.js    — downstream caller
 *   src/server/ai/__tests__/validateTailorOutput.integration.test.js
 */
import { TailorResponse } from '../../shared/schemas/profile.js';

// ------------------------------------------------------------------
// Canary patterns
// ------------------------------------------------------------------

const XSS_CANARIES = [
  /<script/i,
  /javascript:/i,
  /data:(image|text|application)\//i,
  /onerror=/i,
];

const CREDENTIAL_CANARIES = [
  /sk-[a-zA-Z0-9]{20,}/,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/,
];

// Base64 blob: 100+ chars of base64 alphabet.
// LOG-ONLY in Phase 0. False-positives are acceptable at this stage;
// Phase 5 corpus data will drive the decision to harden or drop.
const BASE64_BLOB = /[A-Za-z0-9+/=]{100,}/;

// ------------------------------------------------------------------
// Recursive deep-scan helpers
// ------------------------------------------------------------------

/**
 * Scans a single string for XSS or credential canaries.
 * Returns a reason string if a canary is found, null otherwise.
 *
 * @param {string} str
 * @returns {string|null}
 */
function scanString(str) {
  for (const pattern of XSS_CANARIES) {
    if (pattern.test(str)) return 'xss_canary';
  }
  for (const pattern of CREDENTIAL_CANARIES) {
    if (pattern.test(str)) return 'credential_canary';
  }
  return null;
}

/**
 * Recursively walks an object/array/string and returns the first canary
 * reason found, or null if clean.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function deepScan(value) {
  if (typeof value === 'string') return scanString(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepScan(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const hit = deepScan(v);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Recursively checks if any string in the value contains a base64 blob.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function containsBase64Blob(value) {
  if (typeof value === 'string') return BASE64_BLOB.test(value);
  if (Array.isArray(value)) return value.some(containsBase64Blob);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsBase64Blob);
  }
  return false;
}

// ------------------------------------------------------------------
// Main export
// ------------------------------------------------------------------

/**
 * Validates Claude's raw text output.
 *
 * Steps:
 *   1. JSON.parse
 *   2. Zod parse against TailorResponse (enforces all length caps)
 *   3. Deep scan for XSS canaries — reject if found
 *   4. Deep scan for credential canaries — reject if found
 *   5. Base64 blob detection — log-only warning, does not reject
 *
 * @param {string} rawText - The text extracted from Claude's response
 * @returns {
 *   { valid: true,  parsed: import('../../shared/schemas/profile.js').TailorResponse, warnings?: string[] } |
 *   { valid: false, reason: string }
 * }
 */
export function validateTailorOutput(rawText) {
  // Step 1: JSON parse
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { valid: false, reason: 'invalid_json' };
  }

  // Step 2: Schema validation
  const result = TailorResponse.safeParse(parsed);
  if (!result.success) {
    return { valid: false, reason: 'schema_mismatch' };
  }

  // Step 3 & 4: Canary scan on the validated (safe-to-traverse) data
  const canaryHit = deepScan(result.data);
  if (canaryHit) {
    return { valid: false, reason: canaryHit };
  }

  // Step 5: Base64 blob — warning only
  const warnings = containsBase64Blob(result.data)
    ? ['base64_blob_detected']
    : undefined;

  return {
    valid: true,
    parsed: result.data,
    ...(warnings ? { warnings } : {}),
  };
}
