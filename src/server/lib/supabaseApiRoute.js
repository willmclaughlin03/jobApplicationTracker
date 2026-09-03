/**
 * Per-request Supabase SSR client factory for Next.js API routes
 *
 * Purpose: Creates a Supabase client that reads auth tokens from request cookies
 * and writes refreshed tokens back via Set-Cookie response headers.
 *
 * @supabase/ssr handles chunked cookies automatically — large JWTs are split
 * across sb-<ref>-auth-token.0, .1, etc. The getAll/setAll adapter reads and
 * writes all chunks transparently.
 *
 * Cookie security options are enforced in setAll regardless of what @supabase/ssr
 * passes, with one exception: maxAge is left to supabase so that sign-out
 * (maxAge: 0) correctly expires cookies.
 *
 * IMPORTANT: Only import this file in pages/api/* — never in client code.
 *
 * Connects to:
 * - @supabase/ssr createServerClient for cookie-based session management
 * - cookie package for RFC 6265-compliant serialization
 */
import { createServerClient } from '@supabase/ssr';
import { serialize } from 'cookie';
import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Creates a per-request Supabase client scoped to a single API route call.
 * Automatically refreshes the access token when needed and writes the updated
 * tokens back to the response as httpOnly cookies.
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 * @param {import('next').NextApiResponse} res - Next.js API response
 * @returns {import('@supabase/supabase-js').SupabaseClient} SSR Supabase client
 */
export function createApiRouteClient(req, res) {
  res.setHeader('Cache-Control', PRIVATE_NO_STORE);
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      /**
       * Returns all request cookies as { name, value } pairs.
       * req.cookies is a plain object in Next.js Pages Router API routes.
       */
      getAll() {
        return Object.keys(req.cookies).map(name => ({
          name,
          value: req.cookies[name]
        }));
      },

      /**
       * Serializes and appends Set-Cookie headers to the response.
       *
       * Security options are always enforced. maxAge is not overridden so
       * that @supabase/ssr can pass maxAge: 0 during sign-out to expire cookies.
       *
       * @param {Array<{name: string, value: string, options: object}>} cookies
       */
      setAll(cookies) {
        const serialized = cookies.map(({ name, value, options }) =>
          serialize(name, value, {
            maxAge: 604800,  // 7 days — default, supabase may override (e.g. 0 on sign-out)
            ...options,
            // Security attributes always enforced after spreading supabase options
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/'
          })
        );

        const existing = res.getHeader('Set-Cookie') ?? [];
        res.setHeader(
          'Set-Cookie',
          [...(Array.isArray(existing) ? existing : [existing]), ...serialized]
        );
      }
    }
  });
}
