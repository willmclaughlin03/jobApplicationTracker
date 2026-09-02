import { createHash } from 'node:crypto';

export const TEMPORARY_SESSION_REDIS_LIMIT = 400;
export const TEMPORARY_SESSION_REDIS_WINDOW_SECONDS = 60;
export const TEMPORARY_SESSION_REDIS_SLOT_COUNT = 61;
export const TEMPORARY_SESSION_REDIS_TTL_SECONDS = 61;
const TEMPORARY_SESSION_REDIS_HASH_FIELD_COUNT = 1 + (2 * TEMPORARY_SESSION_REDIS_SLOT_COUNT);

export const TEMPORARY_SESSION_REDIS_SCRIPT = `
local result_version = 1
local invalid_state = {result_version, 2, 0}

if #KEYS ~= 1 or #ARGV ~= 0 then
  return invalid_state
end

local key = KEYS[1]
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1])
if not now or now < 0 or now % 1 ~= 0 then
  return invalid_state
end

local key_type_result = redis.call('TYPE', key)
local key_type = type(key_type_result) == 'table' and key_type_result['ok'] or key_type_result
if key_type ~= 'none' and key_type ~= 'hash' then
  return invalid_state
end

local fields = {'v'}
for index = 0, ${TEMPORARY_SESSION_REDIS_SLOT_COUNT - 1} do
  table.insert(fields, 'l' .. index)
  table.insert(fields, 'c' .. index)
end

local labels = {}
local counts = {}
local total = 0
local stored_total = 0
local oldest = nil
local exists = key_type == 'hash'

if exists then
  local field_count = redis.call('HLEN', key)
  local ttl = redis.call('TTL', key)
  if field_count ~= ${TEMPORARY_SESSION_REDIS_HASH_FIELD_COUNT} or ttl < 0 or ttl > ${TEMPORARY_SESSION_REDIS_TTL_SECONDS} then
    return invalid_state
  end
  local values = redis.call('HMGET', key, unpack(fields))
  if #values ~= ${TEMPORARY_SESSION_REDIS_HASH_FIELD_COUNT} or values[1] ~= '1' then
    return invalid_state
  end

  for index = 0, ${TEMPORARY_SESSION_REDIS_SLOT_COUNT - 1} do
    local label_raw = values[(index * 2) + 2]
    local count_raw = values[(index * 2) + 3]
    local label = tonumber(label_raw)
    local count = tonumber(count_raw)
    if not label or not count
      or label % 1 ~= 0 or count % 1 ~= 0
      or tostring(label) ~= label_raw or tostring(count) ~= count_raw
      or label < -1 or label > now
      or count < 0 or count > ${TEMPORARY_SESSION_REDIS_LIMIT}
      or (count == 0 and label ~= -1)
      or (count > 0 and (label < 0 or label % ${TEMPORARY_SESSION_REDIS_SLOT_COUNT} ~= index)) then
      return invalid_state
    end

    if count > 0 and label < now - ${TEMPORARY_SESSION_REDIS_WINDOW_SECONDS} then
      label = -1
      count = 0
    end
    labels[index] = label
    counts[index] = count
    stored_total = stored_total + count
    if stored_total > ${TEMPORARY_SESSION_REDIS_LIMIT} then
      return invalid_state
    end
    if count > 0 and label >= now - ${TEMPORARY_SESSION_REDIS_WINDOW_SECONDS} then
      total = total + count
      if total > ${TEMPORARY_SESSION_REDIS_LIMIT} then
        return invalid_state
      end
      if not oldest or label < oldest then
        oldest = label
      end
    end
  end
else
  for index = 0, ${TEMPORARY_SESSION_REDIS_SLOT_COUNT - 1} do
    labels[index] = -1
    counts[index] = 0
  end
end

if total >= ${TEMPORARY_SESSION_REDIS_LIMIT} then
  local retry_seconds = (oldest or now) + ${TEMPORARY_SESSION_REDIS_SLOT_COUNT} - now
  if retry_seconds < 1 then retry_seconds = 1 end
  if retry_seconds > ${TEMPORARY_SESSION_REDIS_WINDOW_SECONDS} then retry_seconds = ${TEMPORARY_SESSION_REDIS_WINDOW_SECONDS} end
  return {result_version, 1, retry_seconds}
end

local current_index = now % ${TEMPORARY_SESSION_REDIS_SLOT_COUNT}
if labels[current_index] ~= now then
  labels[current_index] = now
  counts[current_index] = 0
end
counts[current_index] = counts[current_index] + 1

local write_arguments = {key, 'v', '1'}
for index = 0, ${TEMPORARY_SESSION_REDIS_SLOT_COUNT - 1} do
  table.insert(write_arguments, 'l' .. index)
  table.insert(write_arguments, tostring(labels[index]))
  table.insert(write_arguments, 'c' .. index)
  table.insert(write_arguments, tostring(counts[index]))
end
redis.call('HSET', unpack(write_arguments))
redis.call('EXPIRE', key, ${TEMPORARY_SESSION_REDIS_TTL_SECONDS})
return {result_version, 0, 0}
`.trim();

export const TEMPORARY_SESSION_REDIS_SCRIPT_SHA = createHash('sha1')
  .update(TEMPORARY_SESSION_REDIS_SCRIPT)
  .digest('hex');

/**
 * Creates the sanitized error exposed by script execution.
 *
 * Why: Redis transport messages and key-adjacent provider details must never
 * reach request logging, telemetry, or response output.
 *
 * @returns {Error} sanitized uncertainty error
 */
function createScriptUnavailableError() {
  const error = new Error('temporary session Redis evaluation is unavailable');
  error.name = 'TemporarySessionRedisUnavailableError';
  return error;
}

/**
 * Determines whether an error begins with Redis's exact NOSCRIPT code.
 *
 * Why: only a definitely non-executed cached-script lookup is safe to repeat
 * with EVAL; the Upstash auto-pipeline transport adds one fixed wrapper to that
 * server response, while timeouts, lost responses, and other errors may have
 * consumed a slot.
 *
 * @param {unknown} error Redis client error
 * @returns {boolean} exact NOSCRIPT classification
 */
export function isTemporarySessionNoscriptError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return /^(?:Command failed: )?NOSCRIPT(?: |$)/.test(message);
}

/**
 * Invokes a fixed event hook without allowing telemetry failure to alter Redis.
 *
 * @param {Function|undefined} onEvent fixed telemetry callback
 * @param {string} event fixed internal event label
 * @returns {void}
 */
function emitEvent(onEvent, event) {
  try {
    if (typeof onEvent === 'function') onEvent(event);
  } catch {
    // Telemetry is observational.
  }
}

/**
 * Waits for one Redis operation until the absolute limiter deadline.
 *
 * @param {Promise<unknown>} promise Redis operation
 * @param {number} deadlineAt absolute monotonic deadline
 * @param {Function} now monotonic clock
 * @param {Function} setTimer timer seam
 * @param {Function} clearTimer cleanup seam
 * @returns {Promise<unknown>} Redis result
 */
function waitUntilDeadline(promise, deadlineAt, now, setTimer, clearTimer) {
  const remaining = deadlineAt - now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return Promise.reject(createScriptUnavailableError());
  }
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimer(() => reject(createScriptUnavailableError()), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimer(timeoutId));
}

/**
 * Validates the exact three-integer versioned Lua result.
 *
 * @param {unknown} result raw Redis result
 * @returns {{status: 'allowed'}|{status: 'rate_limited', retryAfterSeconds: number}|{status: 'invalid_state'}} bounded result
 * @throws {Error} sanitized uncertainty error for every unknown shape
 */
export function parseTemporarySessionRedisResult(result) {
  if (!Array.isArray(result)
    || result.length !== 3
    || result.some((value) => !Number.isSafeInteger(value))) {
    throw createScriptUnavailableError();
  }
  if (result[0] !== 1) throw createScriptUnavailableError();
  if (result[1] === 0 && result[2] === 0) return { status: 'allowed' };
  if (result[1] === 1
    && result[2] >= 1
    && result[2] <= TEMPORARY_SESSION_REDIS_WINDOW_SECONDS) {
    return { status: 'rate_limited', retryAfterSeconds: result[2] };
  }
  if (result[1] === 2 && result[2] === 0) return { status: 'invalid_state' };
  throw createScriptUnavailableError();
}

/**
 * Executes the one-key atomic session ceiling with exact NOSCRIPT fallback.
 *
 * Side effects: one EVALSHA is attempted; one EVAL follows only after an exact
 * NOSCRIPT response. No uncertain result is retried.
 *
 * @param {object} redis validated Upstash Redis client
 * @param {string} redisKey internal HMAC-derived Redis key
 * @param {object} options absolute deadline and deterministic seams
 * @returns {Promise<object>} bounded parsed script result
 * @throws {Error} sanitized uncertainty error
 */
export async function executeTemporarySessionRedisScript(redis, redisKey, options = {}) {
  const now = options.now;
  const deadlineAt = options.deadlineAt;
  const setTimer = options.setTimeoutFunction ?? setTimeout;
  const clearTimer = options.clearTimeoutFunction ?? clearTimeout;
  const onEvent = options.onEvent;
  if (!redis
    || typeof redis.evalsha !== 'function'
    || typeof redis.eval !== 'function'
    || typeof redisKey !== 'string'
    || redisKey.length < 1
    || redisKey.length > 256
    || typeof now !== 'function'
    || !Number.isFinite(deadlineAt)) {
    throw createScriptUnavailableError();
  }

  let rawResult;
  try {
    emitEvent(onEvent, 'evalsha');
    rawResult = await waitUntilDeadline(
      Promise.resolve().then(() => redis.evalsha(
        TEMPORARY_SESSION_REDIS_SCRIPT_SHA,
        [redisKey],
        []
      )),
      deadlineAt,
      now,
      setTimer,
      clearTimer
    );
  } catch (error) {
    if (!isTemporarySessionNoscriptError(error)) throw createScriptUnavailableError();
    emitEvent(onEvent, 'noscript_fallback');
    try {
      rawResult = await waitUntilDeadline(
        Promise.resolve().then(() => redis.eval(
          TEMPORARY_SESSION_REDIS_SCRIPT,
          [redisKey],
          []
        )),
        deadlineAt,
        now,
        setTimer,
        clearTimer
      );
    } catch {
      throw createScriptUnavailableError();
    }
  }

  return parseTemporarySessionRedisResult(rawResult);
}
