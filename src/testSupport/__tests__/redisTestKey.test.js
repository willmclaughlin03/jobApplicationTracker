const {
  DEFAULT_REDIS_TEST_TTL_SECONDS,
  buildRedisTestKey,
  exerciseExpiringRedisTestKey,
} = require('../redisTestKey.js');

describe('Redis integration test key safety', () => {
  it('builds a key scoped to one run while retaining the test payload', () => {
    expect(buildRedisTestKey('run-123', 'unicode', 'key-value')).toBe(
      'integration-test:run-123:unicode:key-value'
    );
  });

  it('sets a bounded TTL and deletes only the exact written key', async () => {
    const client = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const key = buildRedisTestKey('run-123', 'injection', 'payload');

    await exerciseExpiringRedisTestKey(client, key, 'value');

    expect(client.set).toHaveBeenCalledWith(
      key,
      'value',
      { ex: DEFAULT_REDIS_TEST_TTL_SECONDS }
    );
    expect(client.del).toHaveBeenCalledTimes(1);
    expect(client.del).toHaveBeenCalledWith(key);
  });

  it('does not issue cleanup for a key that Redis rejected before writing', async () => {
    const client = {
      set: jest.fn().mockRejectedValue(new Error('set rejected')),
      del: jest.fn(),
    };
    const key = buildRedisTestKey('run-123', 'rejected', 'payload');

    await expect(exerciseExpiringRedisTestKey(client, key, 'value'))
      .rejects.toThrow('set rejected');
    expect(client.del).not.toHaveBeenCalled();
  });
});
