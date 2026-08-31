/**
 * Exact Supabase error classification for v2 session lookup.
 *
 * Purpose: Activate only the four Gate-0 class/code/status/operation tuples and
 * keep all unsupported or malformed provider failures unavailable.
 * Connects to: exported Supabase error classes and the operation tracker.
 */

import { AuthApiError, AuthSessionMissingError } from '@supabase/supabase-js';
import { AUTH_STATUS } from '../../shared/constants/authV2.js';
import { AUTH_PROVIDER_OPERATIONS } from './authProviderOperationTracker.js';

export const AUTH_SESSION_CLASSIFIER_ENDPOINTS = Object.freeze({
  SESSION_LOOKUP: 'session_lookup',
});

/**
 * Proves an error was constructed by the exact exported class, not a subclass
 * or a plain object that copied the provider's public fields.
 *
 * @param {unknown} error provider error candidate
 * @param {Function} expectedClass exported Supabase error constructor
 * @returns {boolean} whether the prototype is exactly the expected prototype
 */
function hasExactErrorPrototype(error, expectedClass) {
  try {
    return typeof error === 'object'
      && error !== null
      && Object.getPrototypeOf(error) === expectedClass.prototype;
  } catch {
    return false;
  }
}

/**
 * Applies the frozen endpoint/operation-aware session error decision table.
 * A missing local session requires no provider fetch so remote missing-session
 * behavior cannot be generalized into ordinary anonymity.
 *
 * @param {object} input classifier input
 * @param {unknown} input.endpoint fixed endpoint context
 * @param {unknown} input.operation tracked provider operation or null
 * @param {unknown} input.error provider error candidate
 * @returns {'anonymous'|'terminal_unauthenticated'|'unavailable'} disposition
 */
export function classifyAuthSessionError(input) {
  try {
    if (typeof input !== 'object'
      || input === null
      || input.endpoint !== AUTH_SESSION_CLASSIFIER_ENDPOINTS.SESSION_LOOKUP) {
      return AUTH_STATUS.UNAVAILABLE;
    }

    const { error, operation } = input;
    if (operation === null
      && hasExactErrorPrototype(error, AuthSessionMissingError)
      && error.code === undefined
      && error.status === 400) {
      return AUTH_STATUS.ANONYMOUS;
    }

    if (!hasExactErrorPrototype(error, AuthApiError)) {
      return AUTH_STATUS.UNAVAILABLE;
    }
    if (operation === AUTH_PROVIDER_OPERATIONS.GET_USER
      && error.status === 403
      && (error.code === 'bad_jwt' || error.code === 'user_not_found')) {
      return AUTH_STATUS.ANONYMOUS;
    }
    if (operation === AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH
      && error.status === 400
      && error.code === 'user_banned') {
      return AUTH_STATUS.TERMINAL_UNAUTHENTICATED;
    }
    return AUTH_STATUS.UNAVAILABLE;
  } catch {
    return AUTH_STATUS.UNAVAILABLE;
  }
}
