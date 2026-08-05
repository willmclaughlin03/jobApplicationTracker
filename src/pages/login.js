import { useEffect, useState } from 'react';
import { Inter } from 'next/font/google';
import { useRouter } from 'next/router';
import { ArrowRight, ChartNoAxesCombined } from 'lucide-react';
import { useAuth } from '../client/contexts/AuthContext';
import LoginDottedWave from '../client/components/auth/LoginDottedWave';
import Spinner from '../client/components/Spinner';

const loginFont = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dashboard',
});

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
    setError('');
    setLoading(true);

    const { error: oauthError } = await signInWithOAuth('google');

    if (oauthError) {
      setError(oauthError.message || 'Failed to initiate sign in.');
      setLoading(false);
    }
  };

  if (!authLoading && user) {
    return null;
  }

  return (
    <div className={[loginFont.variable, 'login-root', 'font-dashboard'].join(' ')}>
      <div className="login-frame">
        <LoginDottedWave />

        <div className="relative z-10 flex min-h-[100dvh] w-full flex-col px-4 py-6 sm:px-8 sm:py-8">
          <header
            data-testid="login-brand"
            className="flex items-center gap-2 text-dashboard-caption font-semibold tracking-tight text-dashboard-text"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-[0.2rem] border border-dashboard-accent/70 text-dashboard-accent">
              <ChartNoAxesCombined aria-hidden="true" size={11} strokeWidth={1.7} />
            </span>
            <span>TrackTheApp</span>
          </header>

          <main
            data-testid="login-panel"
            className="login-panel mx-auto w-full max-w-lg flex-1 pt-20 sm:flex sm:flex-col sm:justify-center sm:pb-24 sm:pt-0"
          >
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
                    'dashboard-focus-ring inline-flex min-h-11 w-full items-center rounded-dashboard-control border border-dashboard-accent/60 bg-dashboard-surface/45 px-3.5 py-2.5 text-dashboard-caption font-medium text-dashboard-text shadow-dashboard-panel transition-[background-color,border-color,box-shadow,opacity] duration-dashboard ease-dashboard hover:border-dashboard-accent-hover/80 hover:bg-dashboard-surface-raised/65 hover:shadow-[0_0_24px_rgb(var(--dash-accent)/0.16)] disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-12 sm:px-4 sm:py-3 sm:text-dashboard-body',
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
          </main>
        </div>
      </div>
    </div>
  );
}
