import { withRateLimit } from '../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../shared/constants/tiers.js';
import { getRedisClient } from '../../server/lib/redis.js';
import { supabaseAdmin } from '../../server/lib/supabaseServer.js';

const HEALTH_CHECK_TIMEOUT_MS = 3000;

/**
 * Health check endpoint for uptime monitors
 *
 * Purpose: Returns service health status for Redis and Supabase
 * Connects to: Axiom uptime monitors, external health checkers
 *
 * Rate-limited at 60 req/hour per IP via withRateLimit (OPERATIONS.HEALTH).
 * Assumes uptime monitors poll every 60 seconds. Aggressive polling may
 * receive 429 responses.
 *
 * This is the only place that pings Redis directly — rate-limit traffic
 * determines health everywhere else.
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 */
async function handler(req, res) {
  const withTimeout = (promise, label) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${label} health check timeout`)),
        HEALTH_CHECK_TIMEOUT_MS
      );
    });

    return Promise.race([
      promise,
      timeoutPromise,
    ]).finally(
      /**
       * Clears the losing timeout after either health operation settles.
       *
       * Purpose: Prevent successful or failed early checks from retaining a
       * referenced Node timer for the rest of the three-second timeout window.
       *
       * @returns {void}
       */
      () => clearTimeout(timeoutId)
    );
  };

  const [redisResult, supabaseResult] = await Promise.allSettled([
    withTimeout(
      (async () => {
        const client = getRedisClient();
        if (!client) return false;
        return (await client.ping()) === 'PONG';
      })(),
      'Redis'
    ),
    withTimeout(
      supabaseAdmin.from('jobs').select('id').limit(1).maybeSingle(),
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

  if (status !== 'ok') {
    req.log.warn({ status, checks: body.checks }, 'Health check degraded');
  }

  return res.status(status === 'ok' ? 200 : 503).json(body);
}

export default withRateLimit(handler, {
  requireAuth: false,
  allowedMethods: ['GET'],
  operation: OPERATIONS.HEALTH,
});
