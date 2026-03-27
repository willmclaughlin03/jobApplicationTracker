import { attachRequestLogger } from '../../shared/logger.js';
import { sendError } from '../../shared/response.js';
import { isRedisUp } from '../../server/lib/redis.js';
import { supabaseAdmin } from '../../server/lib/supabaseServer.js';

const HEALTH_CHECK_TIMEOUT_MS = 3000;

/**
 * Health check endpoint for uptime monitors
 *
 * Purpose: Returns service health status for Redis and Supabase
 * Connects to: Axiom uptime monitors, external health checkers
 *
 * Intentionally excludes withRateLimit — uptime monitors must not be throttled.
 * Uses attachRequestLogger directly for request-id correlation.
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 */
async function handler(req, res) {
  const requestId = attachRequestLogger(req);
  res.setHeader('x-request-id', requestId);

  if (req.method !== 'GET') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is allowed');
  }

  const withTimeout = (promise, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} health check timeout`)), HEALTH_CHECK_TIMEOUT_MS)
      ),
    ]);

  const [redisResult, supabaseResult] = await Promise.allSettled([
    withTimeout(isRedisUp(), 'Redis'),
    withTimeout(
      supabaseAdmin.from('jobs').select('id', { count: 'exact', head: true }).limit(0),
      'Supabase'
    ),
  ]);

  const redisOk = redisResult.status === 'fulfilled' && redisResult.value === true;
  const supabaseOk =
    supabaseResult.status === 'fulfilled' && !supabaseResult.value?.error;

  const status = redisOk && supabaseOk ? 'ok' : 'degraded';
  const body = {
    status,
    checks: {
      redis: redisOk ? 'ok' : 'fail',
      supabase: supabaseOk ? 'ok' : 'fail',
    },
    timestamp: new Date().toISOString(),
  };

  if (status === 'ok') {
    req.log.info({ status }, 'Health check passed');
  } else {
    req.log.warn({ status, checks: body.checks }, 'Health check degraded');
  }

  return res.status(status === 'ok' ? 200 : 503).json(body);
}

export default handler;
