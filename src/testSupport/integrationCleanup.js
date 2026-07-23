/**
 * Run every registered integration cleanup step and report failures by label.
 *
 * Purpose: Supabase cleanup calls can either reject or resolve with an
 * `{ error }` result, so trusted suites need one fail-closed boundary that
 * attempts all teardown work without exposing provider diagnostics.
 *
 * @param {Array<{ label: string, cleanup: () => unknown|Promise<unknown> }>} steps
 * static cleanup labels and callbacks in dependency-safe execution order
 * @returns {Promise<void>}
 * @throws {AggregateError} names-only failure details after every step runs
 */
async function runIntegrationCleanup(steps) {
  const failedLabels = [];

  for (const step of steps) {
    try {
      const result = await step.cleanup();
      if (
        result
        && typeof result === 'object'
        && Object.prototype.hasOwnProperty.call(result, 'error')
        && result.error != null
      ) {
        failedLabels.push(step.label);
      }
    } catch {
      failedLabels.push(step.label);
    }
  }

  if (failedLabels.length === 0) {
    return;
  }

  const uniqueFailedLabels = [...new Set(failedLabels)];
  throw new AggregateError(
    uniqueFailedLabels.map((label) => new Error(label)),
    [
      'Integration cleanup failed for steps:',
      ...uniqueFailedLabels.map((label) => `- ${label}`),
    ].join('\n')
  );
}

module.exports = {
  runIntegrationCleanup,
};
