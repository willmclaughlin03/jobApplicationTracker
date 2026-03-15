/**
 * Next.js Edge Middleware — automatic session refresh
 *
 * Purpose: Runs on every page navigation request to silently refresh the
 * Supabase access token when it has expired but a valid refresh token is
 * present in the cookies. Writes the updated tokens back to the response
 * so the browser always has a fresh session without requiring a sign-in.
 *
 * Uses the anon key (not service role) — middleware runs at the Edge and
 * only needs to validate/refresh the user's own session.
 *
 * API routes are excluded from the matcher: they verify auth independently
 * via getUserFromRequest(), so running middleware on them would double-verify
 * every request and add unnecessary latency.
 *
 * Connects to:
 * - @supabase/ssr createServerClient for cookie-based session management
 * - NextRequest/NextResponse for Edge-compatible cookie access
 */
import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

export async function middleware(req) {
  // supabaseResponse is re-assigned inside setAll when tokens are refreshed,
  // so we use let and close over it in the cookie adapter below.
  let supabaseResponse = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },

        setAll(cookiesToSet) {
          // Step 1: update req.cookies so any downstream middleware/handlers
          // in the same request chain see the refreshed tokens immediately.
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));

          // Step 2: create a new response based on the updated request so the
          // refreshed cookies are propagated to the browser.
          supabaseResponse = NextResponse.next({ request: req });

          // Step 3: write the refreshed tokens to the response with enforced
          // security options. maxAge is not overridden so supabase can still
          // pass maxAge: 0 to expire cookies when signing out.
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, {
              maxAge: 604800, // 7-day default; supabase may override (e.g. 0 on sign-out)
              ...options,
              // Security attributes always enforced last
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
              path: '/'
            });
          });
        }
      }
    }
  );

  // getUser() triggers a token refresh if the access token is expired and a
  // valid refresh token exists. The refreshed tokens are written to the
  // response via the setAll callback above.
  try {
    await supabase.auth.getUser();
  } catch {
    // Supabase unreachable — degrade gracefully instead of 500-ing every
    // page navigation. The user keeps their existing (possibly stale) cookies
    // and the next API call will surface the auth error where it can be handled.
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static  (Next.js build output — no auth needed)
     * - _next/image   (Next.js image optimisation — no auth needed)
     * - favicon.ico
     * - api/          (API routes verify auth themselves via getUserFromRequest)
     * - Common static asset extensions
     */
    '/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
  ]
};
