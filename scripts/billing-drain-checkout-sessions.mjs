#!/usr/bin/env node

const DRAIN_MAX_LIMIT = 500;
const DEFAULT_RUNS = 2;
const MAX_RUNS = 5;

/**
 * Create a stable CLI argument error for operator command failures.
 *
 * Purpose: invalid operator input should produce a predictable non-secret
 * error code without importing billing modules or reading runtime secrets.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createCliError(message) {
  const error = new Error(message);
  error.code = 'BILLING_CHECKOUT_DRAIN_INVALID_ARGS';
  return error;
}

/**
 * Parse a positive integer flag value with an upper bound.
 *
 * Purpose: mirror the drain service's bounded batch behavior at the operator
 * boundary so accidental large runs fail before any database or Stripe work.
 *
 * @param {string} name
 * @param {unknown} value
 * @param {number} max
 * @returns {number}
 */
function parseBoundedPositiveInteger(name, value, max) {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';

  if (!/^\d+$/.test(normalizedValue)) {
    throw createCliError(`--${name} must be a positive integer`);
  }

  const parsedValue = Number(normalizedValue);

  if (!Number.isInteger(parsedValue) || parsedValue < 1 || parsedValue > max) {
    throw createCliError(`--${name} must be between 1 and ${max}`);
  }

  return parsedValue;
}

/**
 * Parse supported Checkout drain command flags.
 *
 * Purpose: keep the command intentionally narrow: operators may bound the row
 * batch size and pass count, while runtime credentials still come from env.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, limit?: number, runs: number }}
 */
function parseDrainArgs(argv) {
  const parsedArgs = {
    help: false,
    limit: undefined,
    runs: DEFAULT_RUNS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      return {
        ...parsedArgs,
        help: true,
      };
    }

    if (arg === '--limit') {
      index += 1;
      parsedArgs.limit = parseBoundedPositiveInteger('limit', argv[index], DRAIN_MAX_LIMIT);
      continue;
    }

    if (arg.startsWith('--limit=')) {
      parsedArgs.limit = parseBoundedPositiveInteger(
        'limit',
        arg.slice('--limit='.length),
        DRAIN_MAX_LIMIT
      );
      continue;
    }

    if (arg === '--runs') {
      index += 1;
      parsedArgs.runs = parseBoundedPositiveInteger('runs', argv[index], MAX_RUNS);
      continue;
    }

    if (arg.startsWith('--runs=')) {
      parsedArgs.runs = parseBoundedPositiveInteger('runs', arg.slice('--runs='.length), MAX_RUNS);
      continue;
    }

    throw createCliError(`Unknown argument: ${arg}`);
  }

  return parsedArgs;
}

/**
 * Build the operator help text for the Checkout drain command.
 *
 * Purpose: document the exact supported flags without implying the command
 * reads local env files or supports ad-hoc scripting behavior.
 *
 * @returns {string}
 */
function getUsageText() {
  return [
    'Usage: npm run billing:drain-checkout -- [--limit 100] [--runs 2]',
    '',
    'Expires or reconciles locally open Stripe Checkout Sessions during an emergency halt.',
    'Runtime credentials and mode are read from process.env by the application modules.',
    `--limit must be between 1 and ${DRAIN_MAX_LIMIT}.`,
    `--runs must be between 1 and ${MAX_RUNS}; default is ${DEFAULT_RUNS}.`,
  ].join('\n');
}

/**
 * Redact a Stripe resource id for operator command output.
 *
 * Purpose: the drain library returns raw ids for programmatic callers, but the
 * CLI should not print full Stripe ids to terminals or captured job logs.
 *
 * @param {unknown} id
 * @returns {string | null}
 */
function redactStripeId(id) {
  const normalizedId = typeof id === 'string' ? id.trim() : '';

  if (!normalizedId) {
    return null;
  }

  const prefixMatch = normalizedId.match(/^[^_]+_/);
  const prefix = prefixMatch?.[0] ?? '';
  const suffix = normalizedId.length > 4 ? normalizedId.slice(-4) : normalizedId;

  return `${prefix}***${suffix}`;
}

/**
 * Redact a single drain result before writing it to command output.
 *
 * Purpose: preserve row-level outcomes and local ids for incident accounting
 * while hiding full provider resource ids from durable command logs.
 *
 * @param {unknown} result
 * @returns {object}
 */
function redactDrainResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      outcome: 'invalid_result',
    };
  }

  return {
    ...result,
    stripeCheckoutSessionId: redactStripeId(result.stripeCheckoutSessionId),
  };
}

/**
 * Redact a full drain summary before printing it.
 *
 * Purpose: operators need aggregate counts plus safe row-level outcomes, but
 * command output should not become a source of full Stripe Checkout ids.
 *
 * @param {unknown} summary
 * @returns {object}
 */
function redactDrainSummary(summary) {
  const rawResults = Array.isArray(summary?.results) ? summary.results : [];

  return {
    total: summary?.total ?? 0,
    expired: summary?.expired ?? 0,
    complete: summary?.complete ?? 0,
    alreadyExpired: summary?.alreadyExpired ?? 0,
    skipped: summary?.skipped ?? 0,
    failed: summary?.failed ?? 0,
    results: rawResults.map((result) => redactDrainResult(result)),
  };
}

/**
 * Write one newline-terminated line to an output stream.
 *
 * Purpose: avoid console APIs while still giving operators copyable command
 * output from normal stdout and stderr streams.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {string} value
 * @returns {void}
 */
function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

/**
 * Write a JSON payload as one newline-terminated stream record.
 *
 * Purpose: make command output machine-readable for runbooks, CI jobs, and
 * incident attachments without exposing stack traces or raw provider payloads.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {object} payload
 * @returns {void}
 */
function writeJsonLine(stream, payload) {
  writeLine(stream, JSON.stringify(payload));
}

/**
 * Run the emergency Checkout drain command.
 *
 * Purpose: provide an operator-owned entry point for the Chunk 7 drain library
 * without exposing any HTTP route or loading credentials outside process.env.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const args = parseDrainArgs(process.argv.slice(2));

  if (args.help) {
    writeLine(process.stdout, getUsageText());
    return;
  }

  const { drainOpenCheckoutSessions } = await import(
    '../src/server/lib/billingCheckoutDrain.js'
  );

  for (let runNumber = 1; runNumber <= args.runs; runNumber += 1) {
    const summary = await drainOpenCheckoutSessions(
      args.limit ? { limit: args.limit } : {}
    );

    writeJsonLine(process.stdout, {
      event: 'billing_checkout_session_drain_command_completed',
      run: runNumber,
      runs: args.runs,
      summary: redactDrainSummary(summary),
    });
  }
}

run().catch((error) => {
  writeJsonLine(process.stderr, {
    error: 'BILLING_CHECKOUT_DRAIN_COMMAND_FAILED',
    code: error?.code ?? null,
    message: error?.message ?? 'Checkout drain command failed',
  });
  process.exitCode = 1;
});
