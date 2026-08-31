/**
 * Production-safe constants for the strict v2 authentication contracts.
 *
 * Purpose: Give browser and server code one dependency-free vocabulary for
 * auth state, request intent, and exact response outcomes.
 * Connects to: the independent Gate-0 fixtures and v2 response schemas.
 */

export const AUTH_V2_VERSION = 2;

export const AUTH_STATUS = Object.freeze({
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  ANONYMOUS: 'anonymous',
  UNAVAILABLE: 'unavailable',
  SIGNED_OUT_LOCAL: 'signed_out_local',
  LOGOUT_UNCONFIRMED: 'logout_unconfirmed',
  TERMINAL_UNAUTHENTICATED: 'terminal_unauthenticated',
});

export const AUTH_USER_ROLES = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
});

export const APP_REQUEST_HEADER = 'X-App-Request';
export const APP_REQUEST_VALUE = '1';
export const LOGOUT_INTENT_HEADER = 'X-Logout-Intent';
export const LOGOUT_INTENT_VALUE = '1';
export const PRIVATE_NO_STORE = 'private, no-store';

export const AUTH_SESSION_ERROR_CODES = Object.freeze({
  SESSION_UNAVAILABLE: 'SESSION_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  ACCOUNT_ACCESS_RESTRICTED: 'ACCOUNT_ACCESS_RESTRICTED',
});

export const AUTH_SIGNOUT_STATUS = Object.freeze({
  COMPLETE: 'complete',
  LOCAL_ONLY: 'local_only',
  REJECTED: 'rejected',
});

export const AUTH_SIGNOUT_REMOTE_TERMINATION = Object.freeze({
  CONFIRMED: 'confirmed',
  ALREADY_INVALID: 'already_invalid',
  NOT_NEEDED: 'not_needed',
  UNCONFIRMED: 'unconfirmed',
});

export const AUTH_SIGNOUT_ERROR_CODES = Object.freeze({
  REQUEST_REJECTED: 'LOGOUT_REQUEST_REJECTED',
});
