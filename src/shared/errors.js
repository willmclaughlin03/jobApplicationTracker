export function normalizeError(error, fallbackMessage) {
  if (!error) {
    return {
      message: fallbackMessage,
      code: null,
      details: null
    };
  }

  return {
    message: error.message || fallbackMessage,
    code: error.code || null,
    details: error
  };
}

export const ERROR_MESSAGES = {
  FETCH_FAILED: 'Failed to load jobs. Please refresh the page.',
  ADD_FAILED: 'Failed to add job. Please try again.',
  UPDATE_FAILED: 'Failed to update job. Please try again.',
  DELETE_FAILED: 'Failed to delete job. Please try again.',
  UNAUTHORIZED: 'You must be logged in to perform this action.',
  NOT_FOUND: 'Job not found.',
  INVALID_ID: 'Invalid job ID format.',
  FORBIDDEN: 'You do not have permission to access this resource.',
  METHOD_NOT_ALLOWED: 'Method not allowed.',
  SIGN_IN_FAILED: 'Failed to sign in. Please check your credentials.',
  SIGN_UP_FAILED: 'Failed to create account. Please try again.',
  SIGN_OUT_FAILED: 'Failed to sign out. Please try again.',
};