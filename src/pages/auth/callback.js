/**
 * /auth/callback — OAuth PKCE code exchange via getServerSideProps
 *
 * Purpose: Exchanges the OAuth authorization code for a Supabase session
 * entirely server-side, before any client JavaScript runs. This prevents the
 * browser Supabase client (which always has detectSessionInUrl: true) from
 * racing to consume the code and setting non-httpOnly session cookies.
 *
 * Flow:
 * 1. Google redirects to Supabase Auth, which redirects here with ?code=
 * 2. getServerSideProps exchanges the code via createApiRouteClient (httpOnly cookies)
 * 3. On success → server redirect to validated next path (default /)
 * 4. On error → server redirect to /login?error=sign_in_failed
 *
 * The page component only renders as a brief flash during the server redirect.
 *
 * Connects to:
 * - createApiRouteClient for cookie-based PKCE exchange and session management
 * - generateCsrfToken / setCsrfCookie from server/lib/csrf.js
 */
import Spinner from '../../client/components/Spinner';
import { createApiRouteClient } from '../../server/lib/supabaseApiRoute.js';
import { generateCsrfToken, setCsrfCookie } from '../../server/lib/csrf.js';
import { logger } from '../../shared/logger.js';

export async function getServerSideProps({ req, res, query }) {
  const { code, next: rawNext } = query;

  if (!code || typeof code !== 'string' || code.trim() === '') {
    logger.warn('OAuth callback hit without a valid code param');
    return {
      redirect: { destination: '/login?error=sign_in_failed', permanent: false },
    };
  }

  if (code.length > 2048) {
    logger.warn({ codeLength: code.length }, 'OAuth callback code exceeded max length');
    return {
      redirect: { destination: '/login?error=sign_in_failed', permanent: false },
    };
  }

  // Validate next against open-redirect rules (decode first to catch %5c, %2f%2f, etc.)
  let validatedNext = '/';
  if (typeof rawNext === 'string') {
    let decoded;
    try {
      decoded = decodeURIComponent(rawNext);
    } catch {
      decoded = null;
    }
    if (
      decoded &&
      decoded.startsWith('/') &&
      !decoded.startsWith('//') &&
      !decoded.includes('\\')
    ) {
      validatedNext = decoded;
    }
  }

  const supabase = createApiRouteClient(req, res);

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data?.user) {
      logger.error({ err: error }, 'OAuth code exchange failed in callback');
      return {
        redirect: { destination: '/login?error=sign_in_failed', permanent: false },
      };
    }

    // Issue CSRF token so the first authenticated request succeeds
    const token = generateCsrfToken(data.user.id);
    setCsrfCookie(res, token);

    return {
      redirect: { destination: validatedNext, permanent: false },
    };
  } catch (err) {
    logger.error({ err }, 'Unexpected error during OAuth code exchange in callback');
    return {
      redirect: { destination: '/login?error=sign_in_failed', permanent: false },
    };
  }
}

export default function AuthCallback() {
  // This component only renders as a brief flash while the server redirect
  // is processed. In practice, getServerSideProps always redirects.
  return (
    <div className="min-h-screen flex items-center justify-center text-gray-500">
      <Spinner size="lg" className="text-blue-600" />
    </div>
  );
}
