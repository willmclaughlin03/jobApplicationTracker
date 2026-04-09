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
    details: process.env.NODE_ENV !== 'production'
      ? { name: error.name, message: error.message, stack: error.stack }
      : null,
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
  VALIDATION_ERROR: 'Invalid request parameters.',
  RATE_LIMIT_EXCEEDED: 'Rate limit exceeded. Please try again later.',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable. Please try again later.',
  STORAGE_LIMIT_EXCEEDED: 'You have reached the maximum of 300 job entries. Please delete some entries to add more.',
  CSRF_VALIDATION_FAILED: 'Request validation failed. Please refresh and try again.',
  PASSWORD_RESET_SENT: 'If an account exists with that email, a password reset link has been sent.',
  PASSWORD_RESET_FAILED: 'Failed to reset password. Please try again.',
  PASSWORD_UPDATE_FAILED: 'Failed to update password. Please try again.',
  PASSWORD_UPDATE_SUCCESS: 'Password updated successfully.',
  INTERNAL_SERVER_ERROR: 'An unexpected error occurred. Please try again later.',
  ADMIN_FORBIDDEN: 'Admin access required.',
  ADMIN_USER_NOT_FOUND: 'User not found.',
  ADMIN_DELETE_FAILED: 'Failed to delete user account.',
  ADMIN_ROLE_UPDATE_FAILED: 'Failed to update user role.',
  ADMIN_FETCH_FAILED: 'Failed to retrieve user data.',
  ADMIN_SELF_ACTION: 'You cannot perform this action on your own account.',
};