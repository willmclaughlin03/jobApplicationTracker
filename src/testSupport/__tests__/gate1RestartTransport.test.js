/** Real pinned SDK + fake fetch: tests transport uncertainty without any network. */
const { Redis } = require('@upstash/redis');
const { createTransportGuard } = require('../../../scripts/gate1-restart-transport.js');
const { executeTemporarySessionRedisScript, TEMPORARY_SESSION_REDIS_SCRIPT,
  TEMPORARY_SESSION_REDIS_SCRIPT_SHA } = require('../../server/lib/temporarySessionRedisScript.js');
const { performance } = require('node:perf_hooks');

const KEY = 'synthetic-key-never-retain';
const ORIGIN = 'https://synthetic.upstash.io';
const originalFetch = globalThis.fetch;

/** Creates a bounded fake pipeline response without constructing a network client. */
function response(items) {
  return new Response(JSON.stringify(items), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Installs the observer around a fake backend while retaining default SDK retry/pipeline behavior. */
function fixture(fetchImpl) {
  const failure = jest.fn();
  const guard = createTransportGuard({ fetchImpl, origin: ORIGIN, redisKey: KEY,
    script: TEMPORARY_SESSION_REDIS_SCRIPT, scriptSha: TEMPORARY_SESSION_REDIS_SCRIPT_SHA,
    maxDecisions: 402, onFailure: failure });
  globalThis.fetch = guard.fetch;
  const redis = new Redis({ url: ORIGIN, token: 'synthetic-token-never-retain',
    signal: () => AbortSignal.timeout(80) });
  return { guard, redis, failure };
}

/** Executes the unchanged application script wrapper against the real SDK. */
function evaluate(redis) {
  return executeTemporarySessionRedisScript(redis, KEY, {
    now: () => performance.now(), deadlineAt: performance.now() + 3000 });
}

/** Builds the exact synthetic HTTP command shape for observer boundary cases. */
function options(command = ['evalsha', TEMPORARY_SESSION_REDIS_SCRIPT_SHA, 1, KEY]) {
  return { method: 'POST', body: JSON.stringify([command]), signal: AbortSignal.timeout(1000) };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe('GATE-1 retry observer with real Upstash SDK', () => {
  it('preserves four concurrent allowed decisions in one automatic pipeline', async () => {
    const backend = jest.fn(async (_url, init) => response(JSON.parse(init.body).map(() => ({ result: [1, 0, 0] }))));
    const { guard, redis } = fixture(backend);
    expect(await Promise.all(Array.from({ length: 4 }, () => evaluate(redis))))
      .toEqual(Array.from({ length: 4 }, () => ({ status: 'allowed' })));
    expect(backend).toHaveBeenCalledTimes(1);
    expect(guard.snapshot()).toMatchObject({ forwarded: 1, evalsha: 4, commands: 4,
      retriesBlocked: 0, active: 0, failure: null });
  });

  it('blocks SDK replay after a reply is lost, even when a later send could succeed', async () => {
    let charged = 0;
    const backend = jest.fn(async () => {
      charged += 1;
      if (charged === 1) throw new TypeError('secret-provider-payload');
      return response([{ result: [1, 0, 0] }]);
    });
    const { guard, redis, failure } = fixture(backend);
    await expect(evaluate(redis)).rejects.toThrow('temporary session Redis evaluation is unavailable');
    expect(charged).toBe(1);
    expect(guard.snapshot().retriesBlocked).toBeGreaterThan(0);
    expect(guard.snapshot()).toMatchObject({ failure: 'transport_uncertain', forwarded: 1, active: 0 });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(guard.snapshot())).not.toMatch(/secret|synthetic-key|synthetic-token|upstash\.io/);
  });

  it('allows definite NOSCRIPT fallback through the unchanged application executor', async () => {
    const backend = jest.fn(async (_url, init) => response(JSON.parse(init.body).map((command) =>
      command[0] === 'evalsha' ? { error: 'NOSCRIPT No matching script.' } : { result: [1, 0, 0] })));
    const { guard, redis } = fixture(backend);
    expect(await evaluate(redis)).toEqual({ status: 'allowed' });
    expect(guard.snapshot()).toMatchObject({ forwarded: 2, evalsha: 1, eval: 1,
      noscript: 1, commands: 2, failure: null });
  });

  it('handles a mixed pipeline with one definitely missing script', async () => {
    const backend = jest.fn(async (_url, init) => response(JSON.parse(init.body).map((command, index) =>
      command[0] === 'evalsha' && index === 0 ? { error: 'NOSCRIPT missing' } : { result: [1, 0, 0] })));
    const { guard, redis } = fixture(backend);
    const results = await Promise.all(Array.from({ length: 4 }, () => evaluate(redis)));
    expect(results.every((value) => value.status === 'allowed')).toBe(true);
    expect(guard.snapshot()).toMatchObject({ evalsha: 4, eval: 1, noscript: 1, failure: null });
  });

  it('blocks replay of a whole pipeline after an uncertain result', async () => {
    const backend = jest.fn(async () => { throw new TypeError('synthetic loss'); });
    const { guard, redis } = fixture(backend);
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => evaluate(redis)));
    expect(outcomes.every((value) => value.status === 'rejected')).toBe(true);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(guard.snapshot()).toMatchObject({ evalsha: 4, failure: 'transport_uncertain' });
  });

  it('rejects even a cloned new request after the first uncertainty', async () => {
    const backend = jest.fn(async () => { throw new Error('private'); });
    const { guard } = fixture(backend);
    await expect(guard.fetch(`${ORIGIN}/pipeline`, options())).rejects.toThrow('transport_uncertain');
    await expect(guard.fetch(`${ORIGIN}/pipeline`, options())).rejects.toThrow('transport_uncertain');
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicated request objects even after a successful reply', async () => {
    const backend = jest.fn(async () => response([{ result: [1, 0, 0] }]));
    const { guard } = fixture(backend);
    const init = options();
    await guard.fetch(`${ORIGIN}/pipeline`, init);
    await expect(guard.fetch(`${ORIGIN}/pipeline`, init)).rejects.toThrow('retry_detected');
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong origin', `${ORIGIN}.invalid/pipeline`, options()],
    ['reset', `${ORIGIN}/pipeline`, options(['flushdb'])],
    ['extended expiry', `${ORIGIN}/pipeline`, options(['expire', KEY, 120])],
    ['different identity', `${ORIGIN}/pipeline`, options(['evalsha', TEMPORARY_SESSION_REDIS_SCRIPT_SHA, 1, 'different'])],
    ['unearned EVAL', `${ORIGIN}/pipeline`, options(['eval', TEMPORARY_SESSION_REDIS_SCRIPT, 1, KEY])],
    ['unknown script', `${ORIGIN}/pipeline`, options(['evalsha', 'unknown', 1, KEY])],
  ])('blocks %s before forwarding', async (_name, url, init) => {
    const backend = jest.fn();
    const { guard } = fixture(backend);
    await expect(guard.fetch(url, init)).rejects.toThrow();
    expect(backend).not.toHaveBeenCalled();
    expect(guard.snapshot().failure).not.toBeNull();
  });

  it.each([
    ['redirect', () => new Response(null, { status: 307, headers: { location: 'https://private.invalid' } })],
    ['oversized', () => new Response('x'.repeat(32769))],
    ['invalid JSON', () => new Response('private-invalid-json')],
    ['provider error', () => response([{ error: 'provider-secret-details' }])],
    ['inexact NOSCRIPT', () => response([{ error: 'prefix NOSCRIPT private' }])],
    ['wrong reply count', () => response([])],
  ])('stops on %s without exposing raw data', async (_name, makeResponse) => {
    const backend = jest.fn(async () => makeResponse());
    const { guard } = fixture(backend);
    await expect(guard.fetch(`${ORIGIN}/pipeline`, options())).rejects.toThrow();
    expect(JSON.stringify(guard.snapshot())).not.toMatch(/private|provider-secret/);
    expect(guard.snapshot().active).toBe(0);
    expect(backend.mock.calls[0][1].redirect).toBe('manual');
  });

  it('caps independent clock reads and allows no key inspection', async () => {
    const backend = jest.fn(async () => response([{ result: [1000, 0] }]));
    const { guard } = fixture(backend);
    await guard.fetch(`${ORIGIN}/pipeline`, options(['time']));
    await expect(guard.fetch(`${ORIGIN}/pipeline`, options(['time']))).rejects.toThrow('budget');
    expect(backend).toHaveBeenCalledTimes(1);
  });
});
