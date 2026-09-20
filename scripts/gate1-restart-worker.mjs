/**
 * Private child entrypoint for controlled GATE-1 continuity. Imports the unchanged
 * application source; local socket/configuration adapters are explicitly attributed.
 * Only sanitized IPC leaves this process. Application stdout/stderr are discarded by
 * the parent, and its environment excludes remote logging credentials and preloads.
 */
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import harness from './gate1-restart-continuity.js';
import transport from './gate1-restart-transport.js';

const { LIMITS, collectAttribution } = harness;
const { RestartError, failureCode, createTransportGuard } = transport;
const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clock'), seq: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('decisions'), seq: z.number().int().positive(),
    ids: z.array(z.number().int().min(1).max(402)).min(1).max(4) }).strict(),
]);

/** Starts one bounded child only under the supervisor's explicit IPC contract. */
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--worker'
    || !['A', 'B'].includes(process.argv[3]) || typeof process.send !== 'function'
    || process.env.GATE1_RESTART_CHILD !== '1' || process.env.NODE_ENV !== 'test'
    || process.env.VERCEL || process.env.AXIOM_TOKEN || process.env.NODE_OPTIONS) {
    throw new RestartError('configuration');
  }
  const actor = process.argv[3];
  const nativeFetch = globalThis.fetch;
  let stopped = false;
  let guard;
  let busy = false;
  let nextSequence = 1;
  let consumed = 0;
  let clockRead = false;
  let lastDecisionAt = null;
  const maxDecisions = actor === 'A' ? 200 : 202;
  const firstId = actor === 'A' ? 1 : 201;

  /** Stops all network permanently and sends only a fixed failure code to the parent. */
  function fatal(code) {
    if (stopped) return;
    stopped = true;
    guard?.stop(code);
    if (process.connected) process.send({ type: 'fatal', code, stats: guard?.snapshot() ?? null }, () => {});
    setTimeout(() => process.exit(1), 50);
  }
  /** A vanished supervisor cannot leave a worker or its transport operating unattended. */
  function disconnected() { stopped = true; guard?.stop('cancelled'); process.exit(1); }
  process.once('disconnect', disconnected);
  setTimeout(() => fatal('deadline'), LIMITS.overallMs).unref();
  // Block network even during imports/initialization; only the installed guard opens it.
  globalThis.fetch = async function initializationFetch() { throw new RestartError('configuration'); };

  const attribution = collectAttribution();
  if (attribution.digest !== process.env.GATE1_RESTART_DIGEST) throw new RestartError('attribution');
  const { temporarySessionCeiling } = await import('../src/server/lib/temporarySessionCeiling.js');
  const { getTemporarySessionRuntimePair } = await import('../src/server/lib/temporarySessionSecrets.js');
  const { resolveTemporarySessionSource } = await import('../src/server/lib/temporarySessionSource.js');
  const { deriveTemporarySessionIdentity } = await import('../src/server/lib/temporarySessionIdentity.js');
  const { getRedisClient } = await import('../src/server/lib/redis.js');
  const { TEMPORARY_SESSION_REDIS_SCRIPT: script, TEMPORARY_SESSION_REDIS_SCRIPT_SHA: scriptSha }
    = await import('../src/server/lib/temporarySessionRedisScript.js');
  const req = Object.freeze({ socket: Object.freeze({ remoteAddress: process.env.GATE1_RESTART_SOURCE }) });
  const source = resolveTemporarySessionSource(req, 'local');
  if (!source) throw new RestartError('configuration');
  const pair = await getTemporarySessionRuntimePair();
  const { redisKey } = deriveTemporarySessionIdentity(source, pair.hmac.active);
  const redis = await getRedisClient(pair);
  if (!redis) throw new RestartError('configuration');
  guard = createTransportGuard({ fetchImpl: nativeFetch, origin: new URL(pair.redis.url).origin,
    redisKey, script, scriptSha, maxDecisions, onFailure: fatal });
  globalThis.fetch = guard.fetch;

  /** Handles one command at a time; each decision is charged only by the real facade. */
  async function handle(raw) {
    if (stopped) return;
    try {
      if (busy || JSON.stringify(raw).length > 1024 || globalThis.fetch !== guard.fetch) {
        throw new RestartError('protocol');
      }
      busy = true;
      const command = commandSchema.parse(raw);
      if (command.seq !== nextSequence++) throw new RestartError('protocol');
      let reply;
      if (command.kind === 'clock') {
        if (clockRead || consumed !== (actor === 'A' ? 0 : 201)) throw new RestartError('protocol');
        clockRead = true;
        const observed = await redis.time();
        if (!Array.isArray(observed) || observed.length !== 2
          || observed.some((part) => !/^\d+$/.test(String(part)))) throw new RestartError('clock');
        const redisTime = observed.map(Number);
        if (!Number.isSafeInteger(redisTime[0]) || redisTime[0] > 1e11
          || !Number.isInteger(redisTime[1]) || redisTime[1] > 999999) throw new RestartError('clock');
        reply = { kind: 'clock', redisTime };
      } else {
        if ((actor === 'A' && !clockRead) || consumed + command.ids.length > maxDecisions
          || command.ids.some((id, index) => id !== firstId + consumed + index)
          || (actor === 'B' && consumed < 200 && consumed + command.ids.length > 200)
          || (actor === 'B' && consumed === 200 && command.ids.length !== 1)
          || (actor === 'B' && consumed === 201
            && (!clockRead || performance.now() - lastDecisionAt < LIMITS.quietMs))) {
          throw new RestartError('protocol');
        }
        consumed += command.ids.length;
        const items = await Promise.all(command.ids.map(async (id) => {
          const decision = await temporarySessionCeiling.evaluate(req, { routeVersion: 'v1' });
          return { id, allowed: decision.allowed === true,
            statusCode: decision.allowed === true ? 200 : decision.statusCode,
            retryAfterSeconds: decision.retryAfterSeconds ?? null };
        }));
        lastDecisionAt = performance.now();
        reply = { kind: 'decisions', items };
      }
      if (stopped || guard.snapshot().failure) return;
      busy = false;
      process.send({ type: 'reply', seq: command.seq, ...reply, stats: guard.snapshot() },
        (error) => { if (error) fatal('process_exit'); });
    } catch (error) { fatal(failureCode(error)); }
  }
  process.on('message', handle);
  process.send({ type: 'ready', pid: process.pid, runtime: process.version, digest: attribution.digest },
    (error) => { if (error) fatal('process_exit'); });
}

main().catch((error) => {
  if (process.connected && typeof process.send === 'function') {
    process.send({ type: 'fatal', code: failureCode(error), stats: null }, () => process.exit(1));
    setTimeout(() => process.exit(1), 100).unref();
  } else { process.stderr.write('gate1_restart_worker_unavailable\n'); process.exitCode = 1; }
});
