const DEFAULT_REDIS_TEST_TTL_SECONDS = 60;

/**
 * Build a Redis key owned by one serialized integration-test run.
 *
 * Purpose: shared pre-production Redis may be used temporarily, so every test
 * mutation needs a unique namespace while retaining the payload under test.
 *
 * @param {string} runId unique identifier for the current test process
 * @param {string} label stable label describing the test case
 * @param {string} payload key content exercised by the test
 * @returns {string} exact per-run Redis key
 */
function buildRedisTestKey(runId, label, payload) {
  return 'integration-test:' + runId + ':' + label + ':' + payload;
}

/**
 * Set one expiring Redis test key and delete that exact key in a finally path.
 *
 * Purpose: direct Redis resilience checks must remain bounded and must clean
 * only state owned by the current run, even when the shared database is used.
 *
 * @param {{ set: Function, del: Function }} client Redis client under test
 * @param {string} key exact per-run key to mutate
 * @param {unknown} value value written for the resilience check
 * @param {number} ttlSeconds bounded expiration in seconds
 * @returns {Promise<void>}
 */
async function exerciseExpiringRedisTestKey(
  client,
  key,
  value,
  ttlSeconds = DEFAULT_REDIS_TEST_TTL_SECONDS
) {
  let writeSucceeded = false;

  try {
    await client.set(key, value, { ex: ttlSeconds });
    writeSucceeded = true;
  } finally {
    if (writeSucceeded) {
      await client.del(key);
    }
  }
}

module.exports = {
  DEFAULT_REDIS_TEST_TTL_SECONDS,
  buildRedisTestKey,
  exerciseExpiringRedisTestKey,
};
