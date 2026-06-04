/**
 * Server-side Supabase client with service role key
 *
 * Purpose: Allows server to perform authenticated operations
 * IMPORTANT: Only import this file in pages/api/* - never in client code
 *
 * Connects to:
 * - Supabase Auth for token validation
 * - Supabase Database with admin privileges (bypasses RLS)
 */
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../shared/logger.js';
import { createApiRouteClient } from './supabaseApiRoute.js';
import { AUTH_ERROR_CODES, classifyAuthError } from './authErrorClassifier.js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate environment variables with descriptive errors
if (!supabaseUrl) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable');
}

if (!supabaseServiceKey) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

export { AUTH_ERROR_CODES, classifyAuthError };

/**
 * Authentication result object
 * @typedef {Object} AuthResult
 * @property {Object|null} user - The authenticated user or null
 * @property {string|null} error - Error message if authentication failed
 * @property {'AUTH_INVALID'|'AUTH_NOT_FOUND'|'AUTH_UNAVAILABLE'|null} errorCode - Stable auth failure code
 */

/**
 * Format non-sensitive auth error metadata for logs.
 *
 * Purpose: auth outage logs should be useful without including token, cookie,
 * or session-bearing fields from provider error objects.
 *
 * @param {unknown} error
 * @returns {{ name: unknown, status: unknown, code: unknown }}
 */
function sanitizeAuthErrorForLog(error) {
  return {
    name: error?.name,
    status: error?.status,
    code: error?.code,
  };
}

/**
 * Extracts and validates user from request cookies
 *
 * Purpose: Authenticate API requests using httpOnly cookie-based JWT tokens.
 * Creates a per-request SSR client which also handles silent token refresh —
 * if the access token is expired but the refresh token is valid, a new access
 * token is written back via Set-Cookie before this function returns.
 *
 * Connects to:
 * - createApiRouteClient for cookie-based session management
 * - Supabase Auth service for token validation
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 * @param {import('next').NextApiResponse} res - Next.js API response
 * @returns {Promise<AuthResult>} Object containing user and/or error
 */
export async function getUserFromRequest(req, res) {
  try {
    const supabase = createApiRouteClient(req, res);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error) {
      const errorCode = classifyAuthError(error);

      if (errorCode === AUTH_ERROR_CODES.AUTH_UNAVAILABLE) {
        logger.error(sanitizeAuthErrorForLog(error), 'Authentication service unavailable');
        return {
          user: null,
          error: 'Authentication service unavailable',
          errorCode,
          supabaseClient: null,
        };
      }

      logger.warn(sanitizeAuthErrorForLog(error), 'Token validation failed');
      return {
        user: null,
        error: 'Invalid or expired token',
        errorCode,
        supabaseClient: null,
      };
    }

    if (!user) {
      return {
        user: null,
        error: 'User not found',
        errorCode: AUTH_ERROR_CODES.AUTH_NOT_FOUND,
        supabaseClient: null,
      };
    }

    return { user, error: null, errorCode: null, supabaseClient: supabase };
  } catch (err) {
    logger.error(sanitizeAuthErrorForLog(err), 'Unexpected authentication error');
    return {
      user: null,
      error: 'Authentication service unavailable',
      errorCode: AUTH_ERROR_CODES.AUTH_UNAVAILABLE,
      supabaseClient: null,
    };
  }
}
