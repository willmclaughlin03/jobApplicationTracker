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
import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { supabaseBrowser } from '../lib/supabaseBrowser.js';

const AuthContext = createContext(undefined);

/** Minimum ms between /api/auth/session re-fetches on tab focus */
const SESSION_REFETCH_THROTTLE_MS = 30_000;

/**
 * Fetches the current user from the server session endpoint.
 * Returns the user object or null.
 */
async function fetchSessionUser() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const result = await res.json();
    return result.data?.user ?? null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const lastSessionCheckRef = useRef(0);

  useEffect(() => {
    // One-time cleanup: remove stale sb-* keys left in localStorage from the
    // previous Bearer token approach so they don't linger as an XSS target.
    if (typeof window !== 'undefined') {
      Object.keys(localStorage)
        .filter(k => k.startsWith('sb-'))
        .forEach(k => localStorage.removeItem(k));
    }

    // Check active session on mount via server endpoint
    fetchSessionUser().then(sessionUser => {
      setUser(sessionUser);
      setLoading(false);
      lastSessionCheckRef.current = Date.now();
      // Prime the CSRF cookie so state-changing requests work immediately
      if (sessionUser) {
        fetch('/api/auth/csrf', { credentials: 'same-origin' }).catch(() => {});
      }
    });

    // Re-check session when tab regains focus (throttled to 30s)
    // This handles: sign-out in another tab, token expiry, session refresh
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastSessionCheckRef.current < SESSION_REFETCH_THROTTLE_MS) return;

      lastSessionCheckRef.current = Date.now();
      fetchSessionUser().then(sessionUser => {
        setUser(sessionUser);
        if (sessionUser) {
          fetch('/api/auth/csrf', { credentials: 'same-origin' }).catch(() => {});
        }
      });
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

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
    setUser(null);
    lastSessionCheckRef.current = Date.now();
    return { error: null };
  };

  const value = {
    user,
    loading,
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
 * @returns {Object} Auth context value (user, loading, signInWithOAuth, signOut)
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
