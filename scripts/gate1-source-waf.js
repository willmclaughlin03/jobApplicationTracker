'use strict';

/**
 * Local GATE-1 source diagnostic preparation and fixture runner. No network
 * implementation or live CLI mode is installed. A separate reviewed discovery
 * profile must pin target/build, access/bypass semantics, provider HTTP counts,
 * deadlines and privacy before live approval. Aggregate data never closes WAF
 * agreement. Encrypted expected-source comparison is deliberately not present.
 */
const { z } = require('zod');
const { performance } = require('node:perf_hooks');

const LIMITS = Object.freeze({
  maxAppRequests: 21, maxProviderAttempts: 44, lookupsPerRequest: 2,
  concurrency: 1, requestMs: 10_000, overallMs: 600_000,
  responseBytes: 8_192, probeHeaderBytes: 1_024,
});
const MARKER = /^gate1-source-[a-f0-9]{32}$/;
const FORGED = '192.0.2.71';
const TRUSTED = 'x-vercel-forwarded-for';
const CASES = Object.freeze([
  ['discovery', []], ['control', []],
  ['forged_ipv4', [TRUSTED, FORGED]],
  ['forged_ipv6', [TRUSTED, '2001:db8::71']],
  ['mapped_ipv6', [TRUSTED, '::ffff:192.0.2.71']],
  ['duplicate', [TRUSTED, FORGED, TRUSTED, '192.0.2.72']],
  ['duplicate_casing', [TRUSTED, FORGED, 'X-Vercel-Forwarded-For', '192.0.2.72']],
  ['comma', [TRUSTED, `${FORGED},192.0.2.72`]],
  ['leading_space', [TRUSTED, ` ${FORGED}`]],
  ['trailing_space', [TRUSTED, `${FORGED} `]],
  ['internal_space', [TRUSTED, '192.0. 2.71']],
  ['port', [TRUSTED, `${FORGED}:443`]],
  ['bracket', [TRUSTED, '[2001:db8::71]']],
  ['zone', [TRUSTED, 'fe80::71%eth0']],
  ['malformed', [TRUSTED, 'invalid-address']],
  ['xff', ['X-Forwarded-For', FORGED]],
  ['forwarded', ['Forwarded', `for=${FORGED}`]],
  ['real_ip', ['X-Real-IP', FORGED]],
  ['alternative_combined', ['X-Forwarded-For', FORGED, 'Forwarded', `for=${FORGED}`, 'X-Real-IP', FORGED]],
].map(([id, headers]) => Object.freeze({ id, headers: Object.freeze(headers) })));

const observationSchema = z.object({
  schemaVersion: z.literal(1), scope: z.literal('server_header_observation_only'),
  marker: z.string().length(45).regex(MARKER),
  applicationRequestId: z.union([z.string().regex(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/), z.null()]),
  rawMetadataValid: z.literal(true), trustedHeaderCount: z.number().int().min(0).max(128),
  normalizedShape: z.enum(['scalar', 'missing', 'array', 'other']),
  rawNormalizedEqual: z.union([z.boolean(), z.null()]),
  effectiveMode: z.enum(['not_observed', 'invalid', 'local', 'vercel']),
  sourceResolution: z.enum(['not_attempted', 'accepted', 'rejected']),
  canonicalFamily: z.union([z.literal(4), z.literal(6), z.null()]),
  sourceAgreement: z.literal('not_evaluated'),
}).strict().refine((facts) => (
  (facts.sourceResolution === 'accepted') === (facts.canonicalFamily !== null)
  && (['local', 'vercel'].includes(facts.effectiveMode) || facts.sourceResolution === 'not_attempted')
  && ((facts.trustedHeaderCount === 1 && facts.normalizedShape === 'scalar')
    === (facts.rawNormalizedEqual !== null))
  && (facts.sourceResolution !== 'accepted' || facts.effectiveMode !== 'vercel'
    || (facts.trustedHeaderCount === 1 && facts.rawNormalizedEqual === true))
));

/** Returns a fixed error code only; no external values are placed in errors. */
function stopped(code) {
  return new Error(code);
}

/**
 * Serializes the exact HTTP/1.1 bytes for a fixture; duplicate casing and spaces
 * survive without a normalized header map. The returned buffer is sensitive.
 * @param {object} input synthetic secret/marker, fixed case and hostname
 * @returns {Buffer} transient wire fixture; caller must never log or persist it
 */
function createWireRequest({ hostname, marker, secret, caseId }) {
  const selected = CASES.find((item) => item.id === caseId);
  if (!selected || typeof hostname !== 'string' || hostname.length > 253
    || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostname)
    || typeof marker !== 'string' || !MARKER.test(marker)
    || typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw stopped('fixture_input');
  const headers = ['Host', hostname, 'Connection', 'close', 'Accept', 'application/json',
    'Authorization', `Bearer ${secret}`, 'x-gate1-source-diagnostic', '1', 'User-Agent', marker,
    ...selected.headers];
  let wire = 'GET /api/auth/session HTTP/1.1\r\n';
  for (let index = 0; index < headers.length; index += 2) {
    wire += `${headers[index]}: ${headers[index + 1]}\r\n`;
  }
  return Buffer.from(`${wire}\r\n`, 'ascii');
}

/**
 * Validates a fixture response and projects only reviewed, identifier-free facts.
 * @param {object} response transient response, never spread into a report
 * @param {string} marker expected unique marker for this attempt
 * @returns {object} bounded observation; rejects redirects/cache/body/schema drift
 */
function reviewSourceResponse(response, marker) {
  if (response?.status >= 300 && response.status < 400) throw stopped('redirect');
  if (response?.status !== 200) throw stopped('session_status');
  const headers = response.headers;
  if (!headers || headers['set-cookie'] !== undefined) throw stopped('cookie_contract');
  const cache = headers['cache-control'];
  const directives = typeof cache === 'string' ? cache.toLowerCase().split(',').map((s) => s.trim()) : [];
  if (!directives.includes('private') || !directives.includes('no-store')
    || directives.some((item) => !['private', 'no-store'].includes(item))
    || !['BYPASS', 'MISS'].includes(headers['x-vercel-cache'])) throw stopped('cache_contract');
  if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > LIMITS.responseBytes) {
    throw stopped('body_contract');
  }
  let body;
  try { body = JSON.parse(response.body); } catch { throw stopped('body_contract'); }
  if (!z.object({ data: z.object({ user: z.null() }).strict(), error: z.null(), message: z.literal('Success') })
    .strict().safeParse(body).success) throw stopped('body_contract');
  const header = headers['x-gate1-source-probe'];
  if (typeof header !== 'string' || Buffer.byteLength(header) > LIMITS.probeHeaderBytes) throw stopped('probe_contract');
  let parsed;
  try { parsed = observationSchema.safeParse(JSON.parse(header)); } catch { throw stopped('probe_contract'); }
  if (!parsed.success || parsed.data.marker !== marker || parsed.data.effectiveMode !== 'vercel'
    || parsed.data.sourceResolution !== 'accepted') throw stopped('probe_contract');
  // The marker and request ID are validated transiently; fixtures retain neither.
  const { marker: _marker, applicationRequestId: _id, ...facts } = parsed.data;
  return facts;
}

/**
 * Classifies availability only; even one uniquely filtered aggregate is not a
 * request receipt, sampling/completeness proof, or independent source agreement.
 * @param {object} evidence synthetic provider summary; never raw provider output
 * @returns {object} fixed unqualified disposition with no addresses or digests
 */
function reviewWafEvidence(evidence) {
  const parsed = z.object({
    kind: z.literal('aggregate'), queryAccepted: z.boolean(), markerMatched: z.boolean(),
    rows: z.number().int().min(0).max(1000), count: z.number().int().min(0).max(1_000_000),
    sampled: z.union([z.boolean(), z.null()]), truncated: z.union([z.boolean(), z.null()]),
  }).strict().safeParse(evidence);
  let availability = 'unavailable';
  if (parsed.success && parsed.data.queryAccepted) {
    const data = parsed.data;
    availability = data.rows === 0 && data.count === 0 ? 'no_rows'
      : data.rows === 1 && data.count === 1 && data.markerMatched
        && data.sampled !== true && data.truncated !== true ? 'aggregate_candidate' : 'ambiguous';
  }
  return { availability, correlation: 'unqualified', completeness: 'unqualified', sourceAgreement: 'not_evaluated' };
}

/**
 * Bounds one injected fixture attempt, including queue/setup time; aborts on
 * timeout and absorbs late rejection. No automatic replay occurs.
 * @param {Function} operation fixture callback accepting an AbortSignal
 * @param {number} timeoutMs remaining per-attempt/overall budget
 * @returns {Promise<unknown>} fixture result or sanitized deadline failure
 */
async function boundedAttempt(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(stopped('deadline')); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exercises fixture sequencing and report safety without a built-in transport.
 * Dependencies must be local test doubles. Counts model attempts, not hosted
 * traffic; no live evidence can be produced by this function or CLI.
 * @param {object} options fixed case IDs, synthetic marker factory and callbacks
 * @returns {Promise<object>} strictly local report; external errors are discarded
 */
async function simulateTrial({ caseIds, markerFor, exchange, lookup, now = () => performance.now(),
  requestMs = LIMITS.requestMs, overallMs = LIMITS.overallMs }) {
  const report = { schemaVersion: 1, mode: 'fixture', scope: 'local_fixture_only',
    result: 'stopped', gate1Status: 'open', hostedEvidence: 'not_executed',
    sourceAgreement: 'not_evaluated', appAttempts: 0, providerAttempts: 0,
    validated: 0, observations: [], failure: null };
  const codes = new Set(['fixture_input', 'deadline', 'redirect', 'session_status', 'cookie_contract',
    'cache_contract', 'body_contract', 'probe_contract', 'provider_unqualified']);
  try {
    if (!Array.isArray(caseIds) || caseIds.length === 0 || caseIds.length > CASES.length
      || new Set(caseIds).size !== caseIds.length || caseIds.some((id) => !CASES.some((c) => c.id === id))
      || typeof markerFor !== 'function' || typeof exchange !== 'function' || typeof lookup !== 'function'
      || !Number.isInteger(requestMs) || requestMs < 1 || requestMs > LIMITS.requestMs
      || !Number.isInteger(overallMs) || overallMs < 1 || overallMs > LIMITS.overallMs) throw stopped('fixture_input');
    const start = now();
    if (!Number.isFinite(start) || start < 0) throw stopped('fixture_input');
    let previous = start;
    const markers = new Set();
    /** Checks monotonic progression before/after each operation; returns remaining budget. */
    function remaining() {
      const current = now();
      if (!Number.isFinite(current) || current < previous || current - start >= overallMs) throw stopped('deadline');
      previous = current;
      return Math.min(requestMs, overallMs - (current - start));
    }
    for (const caseId of caseIds) {
      const marker = markerFor(caseId);
      if (typeof marker !== 'string' || !MARKER.test(marker) || markers.has(marker)) throw stopped('fixture_input');
      markers.add(marker);
      const timeout = remaining();
      if (report.appAttempts >= LIMITS.maxAppRequests) throw stopped('fixture_input');
      report.appAttempts += 1;
      const response = await boundedAttempt((signal) => exchange({ caseId, marker, signal }), timeout);
      remaining();
      const facts = reviewSourceResponse(response, marker);
      report.validated += 1;
      let disposition;
      for (let index = 0; index < LIMITS.lookupsPerRequest; index += 1) {
        const providerTimeout = remaining();
        if (report.providerAttempts >= LIMITS.maxProviderAttempts) throw stopped('fixture_input');
        report.providerAttempts += 1;
        const evidence = await boundedAttempt((signal) => lookup({ caseId, marker, signal }), providerTimeout);
        remaining();
        disposition = reviewWafEvidence(evidence);
        if (disposition.availability !== 'no_rows') break;
      }
      report.observations.push({ caseId, facts, waf: disposition });
      if (disposition.availability !== 'aggregate_candidate') throw stopped('provider_unqualified');
    }
    report.result = 'completed';
  } catch (error) {
    report.failure = codes.has(error?.message) ? error.message : 'fixture_failure';
  }
  return report;
}

/** Returns a zero-traffic preparation summary; contains no deployment claims. */
function preparationReport() {
  return { schemaVersion: 1, mode: 'prepare', scope: 'local_preparation_only', gate1Status: 'open',
    appRequests: 0, providerRequests: 0, sourceAgreement: 'not_evaluated',
    liveExecution: 'not_implemented', fullProposalLimits: LIMITS,
    proposedCases: CASES.map((item) => item.id),
    nextStep: 'freeze_separate_small_discovery_profile_and_obtain_live_approval' };
}

if (require.main === module) {
  if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--prepare')) {
    process.stderr.write('Only --prepare is supported. Live execution is not implemented.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(preparationReport(), null, 2)}\n`);
  }
}

module.exports = { LIMITS, CASES, createWireRequest, reviewSourceResponse, reviewWafEvidence,
  simulateTrial, preparationReport };
