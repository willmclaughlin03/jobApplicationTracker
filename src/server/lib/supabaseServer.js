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

/**
 * Authentication result object
 * @typedef {Object} AuthResult
 * @property {Object|null} user - The authenticated user or null
 * @property {string|null} error - Error message if authentication failed
 */

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
      logger.error('Token validation failed', {
        message: error.message,
        status: error.status,
        timestamp: new Date().toISOString()
      });
      return { user: null, error: 'Invalid or expired token', supabaseClient: null };
    }

    if (!user) {
      return { user: null, error: 'User not found', supabaseClient: null };
    }

    return { user, error: null, supabaseClient: supabase };
  } catch (err) {
    logger.error('Unexpected authentication error', {
      message: err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
      timestamp: new Date().toISOString()
    });
    return { user: null, error: 'Authentication service unavailable', supabaseClient: null };
  }
}
