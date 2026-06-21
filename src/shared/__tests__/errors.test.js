const { ERROR_MESSAGES, normalizeError } = require('../errors.js');
const { JOB_STORAGE_ERRORS } = require('../constants/storage.js');

describe('normalizeError', () => {
  it('maps known string error codes to shared public copy', () => {
    const result = normalizeError(
      JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
      ERROR_MESSAGES.UPDATE_FAILED
    );

    expect(result).toEqual(expect.objectContaining({
      message: ERROR_MESSAGES.JOB_LOCKED_BY_PLAN,
      code: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
    }));
  });

  it('maps object error codes to shared public copy when message is absent', () => {
    const result = normalizeError(
      { code: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN },
      ERROR_MESSAGES.UPDATE_FAILED
    );

    expect(result).toEqual(expect.objectContaining({
      message: ERROR_MESSAGES.JOB_LOCKED_BY_PLAN,
      code: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
    }));
  });
});
