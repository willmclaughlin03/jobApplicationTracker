/**
 * Next.js Edge Middleware - session refresh + auth gate
 *
 * Purpose: Runs on every page navigation request to:
 * 1. Silently refresh the Supabase access token when it has expired but a
 *    valid refresh token is present in the cookies.
 * 2. Redirect unauthenticated users to /login on protected routes, preventing
 *    the page shell (layout, sidebar, labels) from reaching the browser.
 *
 * Public routes (/login, /auth/callback, and custom error pages) and unmatched
 * page paths bypass Supabase construction entirely. Unmatched paths continue
 * to Next.js so the real route or 404 behavior remains authoritative.
 *
 * Uses the anon key (not service role) - middleware runs at the Edge and
 * only needs to validate/refresh the user's own session.
 *
 * Graceful degradation: if Supabase is unreachable, the redirect is skipped
 * and the user keeps their existing cookies. The next API call will surface
 * the auth error where it can be handled.
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
import { ERROR_STATUS_CODES } from './shared/constants/errorStatusCodes';
import { PRIVATE_NO_STORE } from './shared/constants/authV2.js';

export const ROUTE_POLICY = Object.freeze({
  PROTECTED: 'protected',
  PUBLIC: 'public',
  UNMATCHED: 'unmatched',
});

const PUBLIC_PATHS = [
  { path: '/login', allowSubpaths: false },
  { path: '/auth/callback', allowSubpaths: false },
  ...ERROR_STATUS_CODES.map((statusCode) => ({ path: `/${statusCode}`, allowSubpaths: false })),
];

const PROTECTED_NAMESPACES = ['/admin', '/billing'];

/**
 * Checks whether a pathname is the named route or one of its subpaths.
 *
 * Purpose: enforce exact segment boundaries so lookalike paths such as
 * /administrator and /billing-example do not enter protected auth handling.
 *
 * @param {string} pathname - Incoming request pathname.
 * @param {string} namespace - Protected route namespace without a trailing slash.
 * @returns {boolean} True when the pathname is inside the namespace.
 */
function isRouteOrSubpath(pathname, namespace) {
  return pathname === namespace || pathname.startsWith(`${namespace}/`);
}

/**
 * Classifies page paths before any authentication client or cookie state exists.
 *
 * Purpose: limit middleware authentication work to known protected pages while
 * allowing exact public pages and unrelated paths to reach Next.js unchanged.
 *
 * @param {string} pathname - Incoming request pathname from NextRequest.
 * @returns {'protected'|'public'|'unmatched'} Explicit page-route policy.
 */
export function classifyRoutePolicy(pathname) {
  if (typeof pathname !== 'string') {
    return ROUTE_POLICY.UNMATCHED;
  }

  const isPublicRoute = PUBLIC_PATHS.some(({ path, allowSubpaths }) => (
    pathname === path || (allowSubpaths && pathname.startsWith(`${path}/`))
  ));
  if (isPublicRoute) {
    return ROUTE_POLICY.PUBLIC;
  }

  if (pathname === '/'
      || PROTECTED_NAMESPACES.some((namespace) => isRouteOrSubpath(pathname, namespace))) {
    return ROUTE_POLICY.PROTECTED;
  }

  return ROUTE_POLICY.UNMATCHED;
}

/**
 * Determines whether a page route should bypass the auth redirect.
 *
 * Purpose: Keep login, OAuth callback, and branded error pages reachable while
 * preserving fail-closed auth gating for the rest of the app shell.
 *
 * @param {string} pathname - Incoming request pathname from NextRequest.
 * @returns {boolean} True when the route is public.
 */
export function isPublicPath(pathname) {
  return classifyRoutePolicy(pathname) === ROUTE_POLICY.PUBLIC;
}

/**
 * Collects the final Supabase descriptor for each response cookie name.
 *
 * Purpose: token refreshes may write a cookie more than once during one request;
 * retaining the final descriptor avoids duplicate or stale browser writes while
 * updating request cookies immediately for downstream authentication work.
 *
 * @param {import('next/server').NextRequest} req - Mutable middleware request.
 * @param {Map<string, {name: string, value: string, options?: object}>} cookies - Cookie collector.
 * @param {Array<{name: string, value: string, options?: object}>} cookiesToSet - Supabase writes.
 * @returns {void}
 */
function collectSupabaseCookies(req, cookies, cookiesToSet) {
  cookiesToSet.forEach(({ name, value, options }) => {
    req.cookies.set(name, value);
    cookies.set(name, { name, value, options });
  });
}

/**
 * Applies protected response policy and deferred Supabase cookie writes once.
 *
 * Purpose: redirects and pass-through responses must receive the same refreshed
 * or deleted cookies without binding cookie collection to a discarded response.
 * Security attributes are enforced after Supabase options while maxAge remains
 * overridable so maxAge: 0 deletion cookies continue to work.
 *
 * @param {import('next/server').NextResponse} response - Selected final response.
 * @param {Map<string, {name: string, value: string, options?: object}>} cookies - Final cookie descriptors.
 * @returns {import('next/server').NextResponse} The finalized protected response.
 */
function finalizeProtectedResponse(response, cookies) {
  response.headers.set('Cache-Control', PRIVATE_NO_STORE);
  response.headers.set('CDN-Cache-Control', 'no-store');
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
  cookies.forEach(({ name, value, options }) => {
    response.cookies.set(name, value, {
      maxAge: 604800,
      ...options,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
  });
  return response;
}

export async function middleware(req) {
  const routePolicy = classifyRoutePolicy(req.nextUrl.pathname);
  if (routePolicy !== ROUTE_POLICY.PROTECTED) {
    return NextResponse.next({ request: req });
  }

  const collectedCookies = new Map();
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        cookies: {
          getAll() {
            return req.cookies.getAll();
          },

          setAll(cookiesToSet) {
            collectSupabaseCookies(req, collectedCookies, cookiesToSet);
          },
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = '/login';
      return finalizeProtectedResponse(NextResponse.redirect(loginUrl), collectedCookies);
    }

    return finalizeProtectedResponse(NextResponse.next({ request: req }), collectedCookies);
  } catch {
    // Supabase unreachable - degrade gracefully instead of 500-ing every
    // page navigation. The user keeps their existing (possibly stale) cookies
    // and the next API call will surface the auth error where it can be handled.
    return finalizeProtectedResponse(NextResponse.next({ request: req }), collectedCookies);
  }
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static  (Next.js build output - no auth needed)
     * - _next/image   (Next.js image optimisation - no auth needed)
     * - favicon.ico
     * - api and api/  (API routes verify auth themselves via getUserFromRequest)
     * - Common static asset extensions
     */
    '/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
  ]
};
