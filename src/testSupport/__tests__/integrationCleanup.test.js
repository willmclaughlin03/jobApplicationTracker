const {
  runIntegrationCleanup,
} = require('../integrationCleanup.js');

const PROVIDER_SENTINEL = 'provider-detail-must-not-appear';
const EMAIL_SENTINEL = 'cleanup-user@example.invalid';
const ID_SENTINEL = '11111111-2222-4333-8444-555555555555';

describe('integration cleanup runner', () => {
  it('completes successfully when every cleanup step succeeds', async () => {
    const firstCleanup = jest.fn().mockResolvedValue({ error: null });
    const secondCleanup = jest.fn().mockResolvedValue(undefined);

    await expect(runIntegrationCleanup([
      { label: 'database rows', cleanup: firstCleanup },
      { label: 'auth users', cleanup: secondCleanup },
    ])).resolves.toBeUndefined();

    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it('treats a resolved error result as a cleanup failure', async () => {
    const cleanup = jest.fn().mockResolvedValue({
      error: new Error(PROVIDER_SENTINEL),
    });

    await expect(runIntegrationCleanup([
      { label: 'database rows', cleanup },
    ])).rejects.toMatchObject({
      message: 'Integration cleanup failed for steps:\n- database rows',
    });
  });

  it('treats a thrown rejection as a cleanup failure', async () => {
    const cleanup = jest.fn().mockRejectedValue(new Error(PROVIDER_SENTINEL));

    await expect(runIntegrationCleanup([
      { label: 'auth users', cleanup },
    ])).rejects.toMatchObject({
      message: 'Integration cleanup failed for steps:\n- auth users',
    });
  });

  it('attempts every step after both returned and thrown failures', async () => {
    const calls = [];

    await expect(runIntegrationCleanup([
      {
        label: 'first rows',
        cleanup: async () => {
          calls.push('first');
          return { error: new Error(PROVIDER_SENTINEL) };
        },
      },
      {
        label: 'second rows',
        cleanup: async () => {
          calls.push('second');
          throw new Error(PROVIDER_SENTINEL);
        },
      },
      {
        label: 'auth users',
        cleanup: async () => {
          calls.push('third');
          return { error: null };
        },
      },
    ])).rejects.toBeInstanceOf(AggregateError);

    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('aggregates multiple failed step labels in registration order', async () => {
    let capturedError;

    try {
      await runIntegrationCleanup([
        {
          label: 'job rows',
          cleanup: async () => ({ error: new Error(PROVIDER_SENTINEL) }),
        },
        {
          label: 'billing rows',
          cleanup: async () => {
            throw new Error(PROVIDER_SENTINEL);
          },
        },
      ]);
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(AggregateError);
    expect(capturedError.message).toBe(
      'Integration cleanup failed for steps:\n'
      + '- job rows\n'
      + '- billing rows'
    );
    expect(capturedError.errors.map((error) => error.message)).toEqual([
      'job rows',
      'billing rows',
    ]);
  });

  it(
    'deduplicates repeated failed labels without dropping distinct failures',
    /**
     * Verifies the cleanup runner reports repeated failure labels once while
     * preserving distinct failures. The returnedFailure, rejectedFailure, and
     * distinctFailure mocks exercise both supported failure channels, and the
     * captured AggregateError guards names-only diagnostics. Its only side
     * effect is invoking those local mocks through runIntegrationCleanup.
     */
    async () => {
      let capturedError;
      const returnedFailure = jest.fn().mockResolvedValue({
        error: new Error(PROVIDER_SENTINEL),
      });
      const rejectedFailure = jest.fn().mockRejectedValue(new Error(PROVIDER_SENTINEL));
      const distinctFailure = jest.fn().mockResolvedValue({
        error: new Error(PROVIDER_SENTINEL),
      });

      try {
        await runIntegrationCleanup([
          { label: 'auth users', cleanup: returnedFailure },
          { label: 'auth users', cleanup: rejectedFailure },
          { label: 'profile rows', cleanup: distinctFailure },
        ]);
      } catch (error) {
        capturedError = error;
      }

      expect(capturedError).toBeInstanceOf(AggregateError);
      expect(capturedError.message).toBe(
        'Integration cleanup failed for steps:\n'
        + '- auth users\n'
        + '- profile rows'
      );
      expect(capturedError.errors.map((error) => error.message)).toEqual([
        'auth users',
        'profile rows',
      ]);
    }
  );

  it('keeps provider messages, emails, ids, and raw errors out of diagnostics', async () => {
    let capturedError;
    const providerError = new Error(
      `${PROVIDER_SENTINEL} ${EMAIL_SENTINEL} ${ID_SENTINEL}`
    );

    try {
      await runIntegrationCleanup([
        {
          label: 'temporary auth users',
          cleanup: async () => ({ error: providerError }),
        },
        {
          label: 'profile rows',
          cleanup: async () => {
            throw providerError;
          },
        },
      ]);
    } catch (error) {
      capturedError = error;
    }

    const serializedDiagnostic = [
      capturedError.message,
      ...capturedError.errors.map((error) => error.message),
    ].join('\n');

    expect(serializedDiagnostic).toContain('temporary auth users');
    expect(serializedDiagnostic).toContain('profile rows');
    expect(serializedDiagnostic).not.toContain(PROVIDER_SENTINEL);
    expect(serializedDiagnostic).not.toContain(EMAIL_SENTINEL);
    expect(serializedDiagnostic).not.toContain(ID_SENTINEL);
    expect(capturedError.errors).not.toContain(providerError);
  });
});
