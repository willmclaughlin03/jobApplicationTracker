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
 * Extracts and validates user from request Authorization header
 *
 * Purpose: Authenticate API requests using JWT tokens
 * Connects to: Supabase Auth service for token validation
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 * @returns {Promise<AuthResult>} Object containing user and/or error
 */
export async function getUserFromRequest(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return { user: null, error: 'Missing Authorization header' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Invalid Authorization header format' };
  }

  const token = authHeader.substring(7);

  if (!token) {
    return { user: null, error: 'Empty token provided' };
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error) {
      // Log the actual error for debugging (server-side only)
      console.error('[Auth] Token validation failed:', {
        message: error.message,
        status: error.status,
        timestamp: new Date().toISOString()
      });
      return { user: null, error: 'Invalid or expired token' };
    }

    if (!user) {
      return { user: null, error: 'User not found' };
    }

    return { user, error: null };
  } catch (err) {
    // Log unexpected errors for debugging
    console.error('[Auth] Unexpected error during authentication:', {
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString()
    });
    return { user: null, error: 'Authentication service unavailable' };
  }
}

/**
 * Middleware wrapper for protected API routes
 *
 * Purpose: Simplify authentication in API handlers
 * Connects to: getUserFromRequest for token validation
 *
 * @param {Function} handler - The API handler function (req, res, user) => Promise
 * @returns {Function} Wrapped handler with authentication
 *
 * @example
 * export default withAuth(async (req, res, user) => {
 *   // user is guaranteed to be authenticated here
 *   res.json({ userId: user.id });
 * });
 */
export function withAuth(handler) {
  return async (req, res) => {
    const { user, error } = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        error: error || 'Unauthorized',
        code: 'UNAUTHORIZED'
      });
    }

    return handler(req, res, user);
  };
}
