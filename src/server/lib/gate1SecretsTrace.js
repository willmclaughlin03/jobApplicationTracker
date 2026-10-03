/**
 * Default-off private stage diagnostics, independent of probe authentication.
 * One attempt per loaded singleton, never a distributed delivery guarantee.
 * Only fixed stage facts enter the existing request logger; no request values do.
 */
import { z } from 'zod';

export const GATE1_SECRETS_TRACE_EVENT = 'gate1_secrets_probe_stage';
export const GATE1_SECRETS_TRACE_BYTES = 1024;
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const armingSchema = z.object({
  schemaVersion: z.literal(1),
  marker: z.string().length(46).regex(/^gate1-secrets-[a-f0-9]{32}$/),
  startsAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict().refine((value) => {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.startsAt);
  return duration > 0 && duration <= 900000;
});
const authentication = z.enum(['not_evaluated', 'probe_disabled', 'runtime_ineligible',
  'production_opt_in_missing', 'configured_credential_invalid', 'raw_metadata_invalid',
  'diagnostic_marker_invalid', 'authorization_invalid', 'credential_mismatch',
  'user_agent_invalid', 'accepted', 'internal_error']);
const emission = z.enum(['not_attempted', 'response_closed', 'facts_rejected',
  'payload_oversized', 'header_write_failed', 'header_set_returned', 'internal_error']);
const recordSchema = z.object({
  event: z.literal(GATE1_SECRETS_TRACE_EVENT), schemaVersion: z.literal(1),
  authentication, observer: z.enum(['not_registered', 'registered_not_invoked', 'invoked_once', 'invoked_multiple']),
  emission, finalHeader: z.enum(['present', 'absent', 'unavailable']),
  routeOutcome: z.enum(['returned', 'threw']), requestId: uuid,
}).strict().refine(consistentRecord);

/** Rejects contradictory records; no later stage is inferred from an earlier one. */
function consistentRecord(record) {
  const invoked = ['invoked_once', 'invoked_multiple'].includes(record.observer);
  if (record.authentication !== 'accepted') {
    return record.observer === 'not_registered' && record.emission === 'not_attempted';
  }
  return record.observer !== 'not_registered'
    && (invoked ? record.emission !== 'not_attempted' : record.emission === 'not_attempted');
}

/** Validates a sanitized private record for offline review; exceptions contain no input. */
export function parseGate1SecretsStageRecord(value) {
  try {
    const parsed = recordSchema.safeParse(value);
    if (parsed.success && Buffer.byteLength(JSON.stringify(parsed.data)) <= GATE1_SECRETS_TRACE_BYTES) return parsed.data;
  } catch { /* Never export schema errors, getters or raw values. */ }
  return null;
}

/**
 * Reviews sanitized records from the separately authorized manual log inspection.
 * The operator must independently establish deployment/window attribution; this
 * local reader only accepts one schema-valid record matching the runner's UUID.
 * Duplicate, unknown, contradictory or unmatched records remain unresolved.
 */
export function reviewGate1SecretsStageRecords(records, requestId) {
  try {
    if (!uuid.safeParse(requestId).success || !Array.isArray(records) || records.length !== 1) return null;
    const record = parseGate1SecretsStageRecord(records[0]);
    return record?.requestId === requestId ? record : null;
  } catch { return null; }
}

/**
 * Creates one local reservation with injectable configuration/clock for fixtures.
 * Selection only enables logging, never loader observation or route authorization.
 */
export function createGate1SecretsTrace({ env = process.env, now = Date.now } = {}) {
  let reserved = false;

  /** Selects an exact route/marker in the armed window and consumes its local slot. */
  function start(req) {
    try {
      if (reserved) return undefined;
      const raw = env.GATE1_SECRETS_TRACE_JSON;
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > GATE1_SECRETS_TRACE_BYTES) return undefined;
      const parsed = armingSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return undefined;
      const config = parsed.data, time = now();
      if (!Number.isFinite(time) || time < Date.parse(config.startsAt) || time >= Date.parse(config.expiresAt)
        || req.method !== 'GET' || req.url !== '/api/auth/session'
        || typeof req.headers?.['user-agent'] !== 'string' || req.headers['user-agent'] !== config.marker) return undefined;
      reserved = true;
      let initialLogger = req.log;
      let state = { authentication: 'not_evaluated', observer: 'not_registered', emission: 'not_attempted' };
      let calls = 0;

      /** Receives only local fixed outcomes; first authentication result and emission win. */
      function record(kind, value) {
        if (!state) return;
        if (kind === 'authentication' && state.authentication === 'not_evaluated' && authentication.safeParse(value).success) {
          state.authentication = value;
          if (value === 'accepted') state.observer = 'registered_not_invoked';
        }
        if (kind === 'invocation' && state.authentication === 'accepted') {
          calls = Math.min(2, calls + 1);
          state.observer = calls === 1 ? 'invoked_once' : 'invoked_multiple';
        }
        if (kind === 'emission' && state.emission === 'not_attempted' && emission.safeParse(value).success) state.emission = value;
      }

      /**
       * Finalizes once after route settlement; logger failures cannot replace its result.
       * Trusts only the middleware's new logger binding, never an incoming ID/header.
       * Pino supplies requestId through its binding, avoiding duplicate JSON keys.
       */
      function finish(request, res, routeOutcome) {
        const snapshot = state;
        state = null;
        const before = initialLogger;
        initialLogger = null;
        if (!snapshot) return;
        try {
          const log = request.log;
          if (!log || log === before || typeof log.info !== 'function' || typeof log.bindings !== 'function') return;
          const bindings = log.bindings();
          // The existing logger binds only pid, hostname and its generated requestId.
          // Unexpected inherited fields are unresolved, never forwarded by this event.
          if (Object.keys(bindings).some((key) => !['pid', 'hostname', 'requestId'].includes(key))) return;
          let finalHeader = 'unavailable';
          try {
            if (typeof res.getHeader === 'function') finalHeader = res.getHeader('X-Gate1-Secrets-Probe') === undefined ? 'absent' : 'present';
          } catch { /* Presence alone is local evidence, never delivery or validity. */ }
          const record = parseGate1SecretsStageRecord({ event: GATE1_SECRETS_TRACE_EVENT, schemaVersion: 1,
            ...snapshot, finalHeader, routeOutcome, requestId: bindings.requestId });
          if (!record) return;
          const { requestId: _requestId, ...payload } = record;
          log.info(payload);
        } catch { /* No fallback logger, raw exception or uncorrelated event. */ }
      }
      return { record, finish };
    } catch { return undefined; }
  }
  return { start };
}

export const gate1SecretsTrace = createGate1SecretsTrace();
