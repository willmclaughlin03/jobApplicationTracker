import { createHash } from 'node:crypto';
import { AUTH_RATE_LIMIT_POLICIES, getAuthRateLimitPolicy } from './authRateLimitPolicy.js';
import {
  AUTH_RATE_LIMIT_NOSCRIPT,
  authRateLimitUnavailableError,
  withinAuthRateLimitDeadline,
} from './authRateLimitRedisClient.js';

const MAX_TIME_SECONDS = 4_102_444_799;
/** Serializes only code-owned operation policies into the static Lua source. */
function luaPolicy([operation, policy]) {
  return `${operation} = {${policy.hourly}, ${policy.daily}}`;
}

export const AUTH_RATE_LIMIT_REDIS_SCRIPT = `
local invalid = {1, 2, 0, 0, 0, 0, 0, 0}
local policies = {${Object.entries(AUTH_RATE_LIMIT_POLICIES.free).map(luaPolicy).join(', ')}}
if #KEYS ~= 1 or #ARGV ~= 1 then return invalid end
local policy = policies[ARGV[1]]
if not policy then return invalid end
local prefix = 'arl:v1:' .. ARGV[1] .. ':'
local digest = string.sub(KEYS[1], #prefix + 1)
if string.sub(KEYS[1], 1, #prefix) ~= prefix or #digest ~= 43
  or not string.match(digest, '^[A-Za-z0-9_-]+$') then return invalid end

-- Parses canonical nonnegative integers within a supplied code-owned bound.
-- Malformed persisted values return nil before any mutation occurs.
local function integer(raw, maximum)
  if type(raw) ~= 'string' or #raw > 10 or not string.match(raw, '^%d+$') then return nil end
  local value = tonumber(raw)
  if not value or value > maximum or string.format('%.0f', value) ~= raw then return nil end
  -- Double arithmetic is exact at these bounds and avoids 32-bit Lua VM wrap.
  return value + 0.0
end
local clock = redis.call('TIME')
if #clock ~= 2 then return invalid end
local now = integer(clock[1], ${MAX_TIME_SECONDS})
local micros = integer(clock[2], 999999)
if not now or not micros then return invalid end
local hour = now - (now % 3600)
local day = now - (now % 86400)
local hour_reset = hour + 3600
local day_reset = day + 86400
local ttl = (day_reset - now) * 1000 - math.floor(micros / 1000)
local hourly_count = 0
local daily_count = 0
local type_result = redis.call('TYPE', KEYS[1])
local key_type = type(type_result) == 'table' and type_result['ok'] or type_result
if key_type ~= 'none' and key_type ~= 'string' then return invalid end
if key_type == 'string' then
  if redis.call('STRLEN', KEYS[1]) > 96 then return invalid end
  local stored_ttl = redis.call('PTTL', KEYS[1])
  if stored_ttl < 0 or stored_ttl > 86400000 then return invalid end
  local raw = redis.call('GET', KEYS[1])
  local hl, dl, hs, hc, ds, dc = string.match(raw, '^1:(%d+):(%d+):(%d+):(%d+):(%d+):(%d+)$')
  hl = integer(hl, 3000)
  dl = integer(dl, 30000)
  hs = integer(hs, ${MAX_TIME_SECONDS})
  hc = integer(hc, policy[1])
  ds = integer(ds, ${MAX_TIME_SECONDS})
  dc = integer(dc, policy[2])
  if not hl or not dl or not hs or not hc or not ds or not dc
    or hl ~= policy[1] or dl ~= policy[2] or hs > hour or ds > day
    or hs % 3600 ~= 0 or ds % 86400 ~= 0 or hs < ds or hs >= ds + 86400
    or hc < 1 or dc < hc then return invalid end
  if hs == hour then hourly_count = hc end
  if ds == day then daily_count = dc end
end

local retry = 0
if hourly_count >= policy[1] then retry = hour_reset - now end
if daily_count >= policy[2] then retry = math.max(retry, day_reset - now) end
if retry > 0 then
  return {1, 1, now, policy[1] - hourly_count, policy[2] - daily_count, hour_reset, day_reset, retry}
end

hourly_count = hourly_count + 1
daily_count = daily_count + 1
local next_value = string.format('1:%.0f:%.0f:%.0f:%.0f:%.0f:%.0f',
  policy[1], policy[2], hour, hourly_count, day, daily_count)
-- One write installs both counters AND expiry. Redis Lua errors cannot roll back
-- earlier commands, so separate counter/expiry writes would not be sufficient.
redis.call('SET', KEYS[1], next_value, 'PX', ttl)
return {1, 0, now, policy[1] - hourly_count, policy[2] - daily_count, hour_reset, day_reset, 0}
`.trim();

export const AUTH_RATE_LIMIT_REDIS_SCRIPT_SHA = createHash('sha1')
  .update(AUTH_RATE_LIMIT_REDIS_SCRIPT).digest('hex');

/**
 * Parses the exact numeric Lua tuple, including coherent boundaries and denial.
 * @param {unknown} raw version/status/time/remaining/reset/retry tuple
 * @param {string} operation previously validated operation
 * @returns {Readonly<object>} bounded metadata; never includes a Redis identity
 */
export function parseAuthRateLimitRedisResult(raw, operation) {
  const policy = getAuthRateLimitPolicy(operation, 'free');
  if (!policy || !Array.isArray(raw) || raw.length !== 8
    || raw.some((value) => !Number.isSafeInteger(value)) || raw[0] !== 1) {
    throw authRateLimitUnavailableError();
  }
  const [, status, now, hr, dr, hReset, dReset, retry] = raw;
  if ((status !== 0 && status !== 1) || now < 0 || now > MAX_TIME_SECONDS
    || hr < 0 || hr > policy.hourly || dr < 0 || dr > policy.daily
    || policy.daily - dr < policy.hourly - hr
    || hReset !== now - (now % 3600) + 3600
    || dReset !== now - (now % 86400) + 86400) throw authRateLimitUnavailableError();
  const expectedRetry = Math.max(hr === 0 ? hReset - now : 0, dr === 0 ? dReset - now : 0);
  if ((status === 0 && (retry !== 0 || hr >= policy.hourly || dr >= policy.daily))
    || (status === 1 && (expectedRetry < 1 || retry !== expectedRetry))) {
    throw authRateLimitUnavailableError();
  }
  const result = {
    status: status === 0 ? 'allowed' : 'rate_limited',
    hourly: Object.freeze({ limit: policy.hourly, remaining: hr, resetAtSeconds: hReset }),
    daily: Object.freeze({ limit: policy.daily, remaining: dr, resetAtSeconds: dReset }),
  };
  if (status === 1) result.retryAfterSeconds = retry;
  return Object.freeze(result);
}

/**
 * Executes EVALSHA, with one static EVAL only for the transport's exact NOSCRIPT.
 * @param {object} redis sanitized request-scoped client
 * @param {string} redisKey internal operation-specific HMAC key
 * @param {string} operation canonical policy
 * @param {object} context shared signal/absolute deadline/monotonic clock
 * @returns {Promise<object>} strict result; uncertainty is sanitized and never retried
 */
export async function executeAuthRateLimitRedisScript(redis, redisKey, operation, context) {
  try {
    if (!getAuthRateLimitPolicy(operation, 'free') || typeof redisKey !== 'string'
      || !new RegExp(`^arl:v1:${operation}:[A-Za-z0-9_-]{43}$`).test(redisKey)) {
      throw authRateLimitUnavailableError();
    }
    let raw;
    try {
      raw = await withinAuthRateLimitDeadline(
        () => redis.evalsha(AUTH_RATE_LIMIT_REDIS_SCRIPT_SHA, [redisKey], [operation]), context
      );
    } catch (error) {
      if (error !== AUTH_RATE_LIMIT_NOSCRIPT) throw error;
      raw = await withinAuthRateLimitDeadline(
        () => redis.eval(AUTH_RATE_LIMIT_REDIS_SCRIPT, [redisKey], [operation]), context
      );
    }
    return parseAuthRateLimitRedisResult(raw, operation);
  } catch {
    throw authRateLimitUnavailableError();
  }
}
