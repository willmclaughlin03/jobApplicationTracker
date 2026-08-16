const {
  Gate0CleanupError,
  Gate0ConfigurationError,
  captureGate0AuthEvidence,
  proveWrongProjectRefRefusal,
  validateGate0Environment,
} = require('./gate0-auth-evidence.js');

const SUPPRESSED_CONSOLE_METHODS = Object.freeze([
  'debug',
  'dir',
  'error',
  'info',
  'log',
  'table',
  'trace',
  'warn',
]);

/**
 * Suppress dependency-owned console output during credentialed capture.
 *
 * Purpose: Supabase may log raw provider errors internally; the trusted runner
 * permits only the audited sanitized JSON written after capture succeeds.
 *
 * @param {() => Promise<unknown>} callback credentialed capture operation
 * @returns {Promise<unknown>} callback result
 */
async function withSuppressedDependencyConsole(callback) {
  const originalConsole = new Map(
    SUPPRESSED_CONSOLE_METHODS.map((method) => [method, console[method]])
  );
  const discard = () => {};

  SUPPRESSED_CONSOLE_METHODS.forEach((method) => {
    console[method] = discard;
  });

  try {
    return await callback();
  } finally {
    originalConsole.forEach((original, method) => {
      console[method] = original;
    });
  }
}

/**
 * Write the one audited command-line error boundary.
 *
 * Purpose: no caught provider error, stack, response, or environment snapshot
 * can be interpolated into stderr.
 *
 * @param {string} message pre-approved static or names-only diagnostic
 * @returns {void}
 */
function writeCliError(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Execute refusal proof, preflight, or the full credentialed evidence capture.
 *
 * Purpose: workflow modes share one target validator, while stdout is reserved
 * exclusively for a completed safe evidence document.
 *
 * @param {string[]} argv command-line arguments after the script path
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {(message: string) => void} writeOutput audited stdout writer
 * @param {(message: string) => void} writeError audited stderr writer
 * @returns {Promise<number>} process exit status
 */
async function runGate0EvidenceCli(
  argv = process.argv.slice(2),
  env = process.env,
  writeOutput = (message) => process.stdout.write(`${message}\n`),
  writeError = writeCliError
) {
  try {
    if (argv.length === 1 && argv[0] === '--prove-project-ref-refusal') {
      proveWrongProjectRefRefusal(env);
      return 0;
    }

    if (argv.length === 1 && argv[0] === '--preflight-only') {
      validateGate0Environment(env);
      return 0;
    }

    if (argv.length !== 0) {
      writeError('Gate-0 evidence runner accepts no arguments outside its two preflight modes.');
      return 1;
    }

    const evidence = await withSuppressedDependencyConsole(
      () => captureGate0AuthEvidence(env)
    );
    writeOutput(JSON.stringify(evidence));
    return 0;
  } catch (error) {
    if (error instanceof Gate0CleanupError) {
      writeError('Gate-0 disposable user cleanup failed; verify and remove synthetic users manually.');
      return 1;
    }

    const safeMessage = error instanceof Gate0ConfigurationError
      ? error.message
      : 'Gate-0 auth evidence capture failed; inspect provider state without exposing errors.';
    writeError(safeMessage);
    return 1;
  }
}

if (require.main === module) {
  runGate0EvidenceCli()
    .then((status) => {
      process.exitCode = status;
    })
    .catch(() => {
      process.exitCode = 1;
      writeCliError('Gate-0 auth evidence runner failed before returning a safe status.');
    });
}

module.exports = {
  runGate0EvidenceCli,
  withSuppressedDependencyConsole,
  writeCliError,
};
