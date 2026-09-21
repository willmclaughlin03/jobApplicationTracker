/**
 * Harness-only transport observation for the pinned Upstash SDK. No application
 * client settings change. A transport uncertainty permanently disqualifies a trial;
 * repeated SDK request objects are blocked before they can reach the network again.
 */
const { z } = require('zod');

const FAILURE_CODES = Object.freeze(['configuration', 'attribution', 'protocol', 'budget',
  'retry_detected', 'transport_uncertain', 'transport_contract', 'response_size',
  'redis_error', 'decision', 'deadline', 'clock', 'process_exit', 'cleanup', 'cancelled']);
const statsSchema = z.object({
  fetchAttempts: z.number().int().min(0).max(5000),
  forwarded: z.number().int().min(0).max(806),
  commands: z.number().int().min(0).max(806),
  evalsha: z.number().int().min(0).max(402),
  eval: z.number().int().min(0).max(402),
  time: z.number().int().min(0).max(2),
  noscript: z.number().int().min(0).max(402),
  retriesBlocked: z.number().int().min(0).max(5000),
  active: z.number().int().min(0).max(4),
  failure: z.enum(FAILURE_CODES).nullable(),
}).strict();

/** Carries only fixed codes; provider errors, causes and payloads never escape. */
class RestartError extends Error {
  /** Selects an allowlisted diagnostic without retaining the original exception. */
  constructor(code) {
    super(FAILURE_CODES.includes(code) ? code : 'protocol');
    this.code = this.message;
  }
}

/** Converts unknown errors into a fixed code rather than serializing their contents. */
function failureCode(error) {
  return error instanceof RestartError ? error.code : 'protocol';
}

/**
 * Reads response.body up to maxBytes before SDK parsing; resolves to a Buffer.
 * Rejects missing bodies or oversized responses with fixed RestartError codes.
 * Consumes the stream, then cancels its reader and releases the lock in finally;
 * collected bytes remain in memory and are never persisted.
 */
async function readBounded(response, maxBytes) {
  if (!response.body) throw new RestartError('transport_contract');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RestartError('response_size');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Guards pinned SDK limiter/clock requests, blocking retries and sends after uncertainty.
 * fetchImpl sends requests; origin, redisKey, script and scriptSha pin allowed inputs.
 * maxDecisions/maxTime cap command counts; signal cancels forwarded requests.
 * Returns { fetch, snapshot, stop }: guarded transport, fixed counters and a stop latch.
 * fetch consumes and rebuilds bounded responses. stop aborts active sends, blocks
 * future forwarding and calls onFailure once. Reused SDK options or any rejection
 * latch failure, including retries with cloned options after a rejection.
 * Credentials and keys stay private and never enter snapshots.
 */
function createTransportGuard({ fetchImpl, origin, redisKey, script, scriptSha,
  maxDecisions, maxTime = 1, onFailure = () => {}, signal }) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(maxDecisions)
    || maxDecisions < 1 || maxDecisions > 402) throw new RestartError('configuration');
  const seen = new WeakSet();
  const controller = new AbortController();
  const stats = { fetchAttempts: 0, forwarded: 0, commands: 0, evalsha: 0, eval: 0,
    time: 0, noscript: 0, retriesBlocked: 0, active: 0, failure: null };
  let fallbackCredits = 0;

  /** Permanently stops this worker's network and informs the independent supervisor. */
  function stop(code = 'cancelled') {
    if (!stats.failure) {
      stats.failure = FAILURE_CODES.includes(code) ? code : 'protocol';
      controller.abort();
      try { onFailure(stats.failure); } catch { /* A failed observer cannot reopen traffic. */ }
    }
  }

  /** Returns fixed counters only, with no request references or provider data. */
  function snapshot() { return { ...stats }; }

  /** Validates commands in memory, allowing EVAL only after definite NOSCRIPT replies. */
  function inspect(input, options) {
    if (options.method !== 'POST' || typeof options.body !== 'string'
      || Buffer.byteLength(options.body) > 65536 || !options.signal) {
      throw new RestartError('transport_contract');
    }
    const url = new URL(input);
    if (url.origin !== origin || url.search || url.hash
      || !['/', '/pipeline'].includes(url.pathname)) throw new RestartError('transport_contract');
    const parsed = JSON.parse(options.body);
    const commands = url.pathname === '/pipeline' ? parsed : [parsed];
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 4) {
      throw new RestartError('transport_contract');
    }
    const kinds = [];
    let shaCount = 0;
    let evalCount = 0;
    let timeCount = 0;
    for (const command of commands) {
      if (!Array.isArray(command)) throw new RestartError('transport_contract');
      const kind = command[0];
      if (kind === 'time' && command.length === 1) timeCount += 1;
      else if (command.length === 4 && command[2] === 1 && command[3] === redisKey
        && kind === 'evalsha' && command[1] === scriptSha) shaCount += 1;
      else if (command.length === 4 && command[2] === 1 && command[3] === redisKey
        && kind === 'eval' && command[1] === script) evalCount += 1;
      else throw new RestartError('transport_contract');
      kinds.push(kind);
    }
    if (stats.evalsha + shaCount > maxDecisions || stats.time + timeCount > maxTime
      || evalCount > fallbackCredits) throw new RestartError('budget');
    stats.evalsha += shaCount;
    stats.eval += evalCount;
    stats.time += timeCount;
    stats.commands += commands.length;
    fallbackCredits -= evalCount;
    return { kinds, pipeline: url.pathname === '/pipeline' };
  }

  /** Forwards each first attempt once; any uncertainty prevents every subsequent send. */
  async function guardedFetch(input, options) {
    stats.fetchAttempts = Math.min(5000, stats.fetchAttempts + 1);
    if (options && typeof options === 'object' && seen.has(options)) {
      stats.retriesBlocked = Math.min(5000, stats.retriesBlocked + 1);
      stop('retry_detected');
      throw new RestartError('retry_detected');
    }
    if (stats.failure) throw new RestartError(stats.failure);
    if (!options || typeof options !== 'object') {
      stop('transport_contract');
      throw new RestartError('transport_contract');
    }
    seen.add(options);
    let entered = false;
    try {
      const { kinds, pipeline } = inspect(input, options);
      if (signal?.aborted || stats.active >= 4) throw new RestartError('cancelled');
      stats.active += 1;
      entered = true;
      stats.forwarded += 1;
      const response = await fetchImpl(input, { ...options, redirect: 'manual',
        signal: AbortSignal.any([options.signal, controller.signal, ...(signal ? [signal] : [])]) });
      if (response.status !== 200 || response.redirected) throw new RestartError('transport_contract');
      const bytes = await readBounded(response, 32768);
      const body = JSON.parse(bytes.toString('utf8'));
      const replies = pipeline ? body : [body];
      if (!Array.isArray(replies) || replies.length !== kinds.length) {
        throw new RestartError('transport_contract');
      }
      for (let index = 0; index < replies.length; index += 1) {
        const reply = replies[index];
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
          throw new RestartError('transport_contract');
        }
        if (reply.error !== undefined) {
          if (kinds[index] !== 'evalsha' || typeof reply.error !== 'string'
            || !/^NOSCRIPT(?: |$)/.test(reply.error)) throw new RestartError('redis_error');
          fallbackCredits += 1;
          stats.noscript += 1;
        } else if (!Object.hasOwn(reply, 'result')) throw new RestartError('transport_contract');
      }
      if (stats.failure) throw new RestartError(stats.failure);
      return new Response(bytes, { status: 200, headers: response.headers });
    } catch (error) {
      stop(error instanceof RestartError ? error.code
        : entered ? 'transport_uncertain' : 'transport_contract');
      throw new RestartError(stats.failure);
    } finally {
      if (entered) stats.active -= 1;
    }
  }
  return { fetch: guardedFetch, snapshot, stop };
}

module.exports = { FAILURE_CODES, RestartError, failureCode, statsSchema, createTransportGuard };
