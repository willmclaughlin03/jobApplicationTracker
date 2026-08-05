import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '../client/contexts/AuthContext';
import PublicPageShell, {
  PUBLIC_PRIMARY_ACTION_CLASS_NAME,
} from '../client/components/public/PublicPageShell';
import Spinner from '../client/components/Spinner';

/**
 * Render the compact four-color Google mark used by the OAuth action.
 *
 * Purpose: Keeps the provider identity local and decorative without loading a
 * remote image or changing the accessible name supplied by the button.
 *
 * @returns {React.ReactElement} Decorative Google provider mark.
 */
function GoogleMark() {
  return (
    <svg
      data-testid="google-mark"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0"
    >
      <path
        fill="#4285F4"
        d="M21.35 11.1H12v3.8h5.38c-.23 1.22-.93 2.25-1.98 2.94v2.45h3.2c1.87-1.72 2.95-4.26 2.95-7.27 0-.69-.06-1.34-.2-1.92Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.61-2.42l-3.2-2.45c-.9.6-2.04.95-3.41.95-2.6 0-4.8-1.75-5.6-4.12H3.1v2.53A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.4 13.96A6 6 0 0 1 6.08 12c0-.68.12-1.34.32-1.96V7.51H3.1A10 10 0 0 0 2 12c0 1.61.39 3.14 1.1 4.49l3.3-2.53Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.92c1.47 0 2.78.5 3.82 1.49l2.86-2.86C16.95 2.93 14.7 2 12 2a10 10 0 0 0-8.9 5.51l3.3 2.53c.8-2.37 3-4.12 5.6-4.12Z"
      />
    </svg>
  );
}

/**
 * Render the public Google OAuth entry point in the emerald application theme.
 *
 * Purpose: Preserves the existing session redirect, callback-error, and OAuth
 * initiation behavior while presenting the approved mobile-first sign-in
 * composition and its responsive loading and failure states.
 *
 * @returns {React.ReactElement|null} Login surface or null during user redirect.
 */
export default function Login() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const signInPendingRef = useRef(false);
  const { signInWithOAuth, user, loading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  // Surface the callback's public failure code without exposing raw details.
  useEffect(() => {
    if (router.query.error === 'sign_in_failed') {
      setError('Sign in failed. Please try again.');
    }
  }, [router.query.error]);

  /**
   * Start one Google OAuth redirect and restore the control after local failure.
   *
   * @returns {Promise<void>} Resolves only when initiation fails or navigation stalls.
   */
  const handleSignIn = async () => {
    if (signInPendingRef.current) {
      return;
    }

    signInPendingRef.current = true;
    setError('');
    setLoading(true);

    try {
      const { error: oauthError } = await signInWithOAuth('google');
      if (!oauthError) {
        return;
      }

      setError(oauthError.message || 'Failed to initiate sign in.');
    } catch {
      setError('Failed to initiate sign in.');
    }

    signInPendingRef.current = false;
    setLoading(false);
  };

  if (!authLoading && user) {
    return null;
  }

  return (
    <PublicPageShell contentTestId="login-panel">
      {authLoading ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-dashboard-body text-dashboard-muted"
        >
          <Spinner size="sm" className="text-dashboard-accent" />
          <span>Loading...</span>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight text-dashboard-text sm:text-[1.75rem] sm:leading-9">
            Sign In
          </h1>
          <p className="mt-1 text-dashboard-caption text-dashboard-muted">
            Welcome back to Track The App
          </p>

          {error && (
            <div
              className="mt-5 rounded-dashboard-control border border-red-400/55 bg-red-500/10 px-3 py-2.5 text-dashboard-caption text-red-100"
              role="alert"
            >
              {error}
            </div>
          )}

          <button
            type="button"
            className={[
              PUBLIC_PRIMARY_ACTION_CLASS_NAME,
              error ? 'mt-4' : 'mt-8',
            ].join(' ')}
            disabled={loading}
            aria-busy={loading || undefined}
            onClick={handleSignIn}
          >
            <GoogleMark />
            <span className="ml-3 flex-1 text-left">
              {loading ? 'Redirecting...' : 'Continue with Google'}
            </span>
            {loading ? (
              <Spinner size="sm" className="ml-3 text-dashboard-accent" />
            ) : (
              <ArrowRight
                aria-hidden="true"
                size={17}
                strokeWidth={1.8}
                className="ml-3 shrink-0 text-dashboard-accent"
              />
            )}
          </button>
        </>
      )}
    </PublicPageShell>
  );
}
