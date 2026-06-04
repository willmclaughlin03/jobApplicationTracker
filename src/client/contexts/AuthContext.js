/**
 * Authentication Context Provider
 *
 * Purpose: Manages authentication state and provides auth methods to the app.
 * All session state is read from the server via /api/auth/session — the browser
 * never has direct access to auth tokens (httpOnly cookies).
 *
 * Connects to:
 * - /api/auth/signout for server-side session clearing
 * - /api/auth/session for server-side session checks
 * - /api/auth/csrf for CSRF token management
 * - supabaseBrowser for initiating Google OAuth redirect (PKCE flow)
 *
 * Security:
 * - Auth tokens stored in httpOnly cookies (not readable by JavaScript)
 * - Re-checks session on tab focus (throttled to 30s) for tab sync
 * - CSRF token primed on mount whenever a session is detected
 */
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { supabaseBrowser } from '../lib/supabaseBrowser.js';

const AuthContext = createContext(undefined);

/** Minimum ms between /api/auth/session re-fetches on tab focus */
const SESSION_REFETCH_THROTTLE_MS = 30_000;
const SESSION_UNKNOWN = Symbol('SESSION_UNKNOWN');
const SESSION_KNOWN = Symbol('SESSION_KNOWN');
const INITIAL_SESSION_RETRY_DELAYS_MS = [1_000, 2_500];
const SESSION_ERROR_CODES = Object.freeze({
  SESSION_UNAVAILABLE: 'SESSION_UNAVAILABLE',
  SESSION_RATE_LIMITED: 'SESSION_RATE_LIMITED',
});

/**
 * Clears a pending retry timer stored in a React ref.
 *
 * Purpose: share cleanup between initial-session retry, manual retry, sign-out,
 * and provider unmount without duplicating timer logic.
 *
 * @param {{ current: ReturnType<typeof setTimeout>|null }} timerRef - Retry timer ref
 */
function clearRetryTimerRef(timerRef) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

/**
 * Parse Retry-After response metadata into a non-negative second count.
 *
 * Purpose: preserve rate-limit timing from /api/auth/session so client retry
 * decisions can distinguish cooldown responses from retryable outages.
 *
 * @param {string|null|undefined} headerValue - Raw Retry-After header
 * @returns {number|null} Parsed seconds or null when unavailable
 */
function parseRetryAfterSeconds(headerValue) {
  if (typeof headerValue !== 'string') {
    return null;
  }

  const trimmedValue = headerValue.trim();
  if (!trimmedValue) {
    return null;
  }

  const numericSeconds = Number.parseInt(trimmedValue, 10);
  if (Number.isFinite(numericSeconds)) {
    return Math.max(0, numericSeconds);
  }

  const retryAtMs = Date.parse(trimmedValue);
  if (Number.isNaN(retryAtMs)) {
    return null;
  }

  return Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000));
}

/**
 * Checks whether a session fetch result means "retry later".
 *
 * Purpose: distinguish a temporary session endpoint failure from an actual
 * unauthenticated session so the UI does not clear a valid in-memory user.
 *
 * @param {Object} sessionResult - Result from fetchSessionUser()
 * @returns {boolean} True when the session state is temporarily unknown
 */
function isSessionUnknown(sessionResult) {
  return sessionResult?.state === SESSION_UNKNOWN;
}

/**
 * Checks whether an unknown session result is safe to retry automatically.
 *
 * Purpose: avoid retrying 429 cooldown responses while allowing tiny bounded
 * recovery from 503/network/JSON failures.
 *
 * @param {Object} sessionResult - Unknown session result from fetchSessionUser()
 * @returns {boolean} True when the result may be retried by the client
 */
function shouldRetryUnknownSession(sessionResult) {
  return isSessionUnknown(sessionResult) && sessionResult.retryable === true;
}

/**
 * Resolves the retry delay for an initial-session recovery attempt.
 *
 * Purpose: keep retry backoff bounded and deterministic so auth recovery cannot
 * burn through public session quota.
 *
 * @param {number} retryAttempt - Zero-based retry attempt count
 * @returns {number} Delay in milliseconds
 */
function getInitialSessionRetryDelayMs(retryAttempt) {
  return INITIAL_SESSION_RETRY_DELAYS_MS[Math.min(retryAttempt, INITIAL_SESSION_RETRY_DELAYS_MS.length - 1)];
}

/**
 * Builds the terminal client-facing error for an unresolved session check.
 *
 * Purpose: let route guards remain fail-closed while pages render a retryable
 * "server unavailable" state instead of an endless spinner.
 *
 * @param {Object} sessionResult - Unknown session result from fetchSessionUser()
 * @returns {{ code: string, status: number|null, retryAfterSeconds: number|null }}
 */
function buildSessionError(sessionResult) {
  return {
    code: sessionResult?.status === 429
      ? SESSION_ERROR_CODES.SESSION_RATE_LIMITED
      : SESSION_ERROR_CODES.SESSION_UNAVAILABLE,
    status: sessionResult?.status ?? null,
    retryAfterSeconds: sessionResult?.retryAfterSeconds ?? null,
  };
}

/**
 * Fetches the current user from the server session endpoint.
 *
 * Returns a known result containing the user/null session state, or an unknown
 * result when the endpoint is rate-limited/unavailable and callers should
 * preserve their current auth state.
 */
async function fetchSessionUser() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const retryAfterSeconds = parseRetryAfterSeconds(res.headers?.get?.('Retry-After'));

    if (!res.ok) {
      return {
        state: SESSION_UNKNOWN,
        status: res.status,
        retryAfterSeconds,
        retryable: res.status === 503,
      };
    }

    const result = await res.json();
    return {
      state: SESSION_KNOWN,
      user: result.data?.user ?? null,
    };
  } catch {
    return {
      state: SESSION_UNKNOWN,
      status: null,
      retryAfterSeconds: null,
      retryable: true,
    };
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState(null);
  const [manualRetryNonce, setManualRetryNonce] = useState(0);
  const lastSessionCheckRef = useRef(0);
  const loadingRef = useRef(true);
  const retryTimerRef = useRef(null);
  const sessionRequestSequenceRef = useRef(0);

  /**
   * Starts a fresh manual session check after a terminal outage state.
   *
   * Purpose: give users a direct recovery path without changing fail-closed
   * route-guard behavior while the session remains unknown.
   *
   * @returns {void}
   */
  const retrySessionCheck = useCallback(() => {
    clearRetryTimerRef(retryTimerRef);
    sessionRequestSequenceRef.current += 1;
    loadingRef.current = true;
    setLoading(true);
    setSessionError(null);
    setManualRetryNonce(currentValue => currentValue + 1);
  }, []);

  useEffect(() => {
    let isMounted = true;

    // One-time cleanup: remove stale sb-* keys left in localStorage from the
    // previous Bearer token approach so they don't linger as an XSS target.
    if (typeof window !== 'undefined') {
      Object.keys(localStorage)
        .filter(k => k.startsWith('sb-'))
        .forEach(k => localStorage.removeItem(k));
    }

    /**
     * Applies a confirmed session result to client auth state.
     *
     * Purpose: centralize state updates so initial load, retry recovery, and
     * visibility refresh all clear loading after a non-unknown result.
     *
     * @param {Object} sessionResult - Known session result from fetchSessionUser()
     */
    function applyKnownSessionResult(sessionResult) {
      setUser(sessionResult.user);
      setSessionError(null);
      loadingRef.current = false;
      setLoading(false);
      lastSessionCheckRef.current = Date.now();

      if (sessionResult.user) {
        fetch('/api/auth/csrf', { credentials: 'same-origin' }).catch(() => {});
      }
    }

    /**
     * Runs a latest-wins session check and optionally schedules bounded retry.
     *
     * Purpose: prevent overlapping session requests from applying stale state
     * while allowing initial 503/network failures to recover automatically.
     *
     * @param {Object} options - Session check options
     * @param {boolean} options.allowRetry - Whether retry can be scheduled
     * @param {number} options.retryAttempt - Zero-based retry attempt count
     */
    async function runSessionCheck({ allowRetry = false, retryAttempt = 0 } = {}) {
      const requestSequence = sessionRequestSequenceRef.current + 1;
      sessionRequestSequenceRef.current = requestSequence;

      const sessionResult = await fetchSessionUser();

      if (!isMounted || requestSequence !== sessionRequestSequenceRef.current) {
        return;
      }

      if (isSessionUnknown(sessionResult)) {
        lastSessionCheckRef.current = Date.now();

        if (
          allowRetry
          && shouldRetryUnknownSession(sessionResult)
          && retryAttempt < INITIAL_SESSION_RETRY_DELAYS_MS.length
        ) {
          clearRetryTimerRef(retryTimerRef);
          retryTimerRef.current = setTimeout(() => {
            runSessionCheck({ allowRetry: true, retryAttempt: retryAttempt + 1 });
          }, getInitialSessionRetryDelayMs(retryAttempt));
        } else if (loadingRef.current) {
          setSessionError(buildSessionError(sessionResult));
        }

        return;
      }

      clearRetryTimerRef(retryTimerRef);
      applyKnownSessionResult(sessionResult);
    }

    runSessionCheck({ allowRetry: true });

    // Re-check session when tab regains focus (throttled to 30s)
    // This handles: sign-out in another tab, token expiry, session refresh
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastSessionCheckRef.current < SESSION_REFETCH_THROTTLE_MS) return;

      lastSessionCheckRef.current = Date.now();
      runSessionCheck({ allowRetry: false });
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      clearRetryTimerRef(retryTimerRef);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [manualRetryNonce]);

  /**
   * Initiates Google OAuth sign-in via browser redirect
   *
   * Purpose: Triggers the Supabase PKCE OAuth flow. Generates a code challenge,
   * stores the verifier in a cookie, and redirects the browser to Google.
   * The browser returns to /auth/callback?code=... after Google authenticates.
   *
   * Connects to:
   * - supabaseBrowser for PKCE challenge generation and redirect
   * - /auth/callback page which receives the code and POSTs to the server
   *
   * Security: No credentials or tokens are handled here. Supabase manages the
   * OAuth state parameter (CSRF protection on the redirect) and PKCE challenge
   * internally. redirectTo must be absolute — Supabase's server issues the
   * final redirect to your app.
   *
   * @param {string} provider - OAuth provider name (e.g. 'google')
   * @returns {Promise<{error: Object|null}>} Only returns if redirect fails
   */
  const signInWithOAuth = async (provider) => {
    const { error } = await supabaseBrowser.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/`,
      },
    });

    if (error) {
      return { error: { message: error.message || 'Failed to initiate sign in.' } };
    }

    // In normal operation the browser navigates away before this returns.
    // This line is only reached if Supabase throws before the redirect fires.
    return { error: null };
  };

  /**
   * Signs out the current user
   *
   * Purpose: Ends user session via server-side cookie clearing
   * Connects to: /api/auth/signout for httpOnly cookie expiration
   *
   * @returns {Promise<{error: Object|null}>} Sign out result
   */
  const signOut = async () => {
    try {
      // Raw fetch (not apiRequest) — signOut uses requireAuth: false with
      // csrfProtect: false so it remains reachable with expired sessions.
      await fetch('/api/auth/signout', {
        method: 'POST',
        credentials: 'same-origin'
      });
    } catch (err) {
      // Network error — proceed to clear client state anyway
    }

    // Clear client-side state — server already cleared the httpOnly cookies
    clearRetryTimerRef(retryTimerRef);
    sessionRequestSequenceRef.current += 1;
    setSessionError(null);
    loadingRef.current = false;
    setUser(null);
    lastSessionCheckRef.current = Date.now();
    return { error: null };
  };

  const value = {
    user,
    loading,
    sessionError,
    retrySessionCheck,
    signInWithOAuth,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Custom hook to access auth context
 *
 * Purpose: Provides type-safe access to auth state and methods
 * Throws: Error if used outside AuthProvider
 *
 * @returns {Object} Auth context value (user, loading, sessionError, retrySessionCheck, signInWithOAuth, signOut)
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
