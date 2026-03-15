/**
 * Authentication Context Provider
 *
 * Purpose: Manages authentication state and provides auth methods to the app.
 * All session state is read from the server via /api/auth/session — the browser
 * never has direct access to auth tokens (httpOnly cookies).
 *
 * Connects to:
 * - /api/auth/signin and /api/auth/signup for server-side auth (rate-limited)
 * - /api/auth/signout for server-side session clearing
 * - /api/auth/session for server-side session checks
 * - /api/auth/csrf for CSRF token management
 * - authSchema.js for input validation (security safeguard)
 *
 * Security:
 * - Auth tokens stored in httpOnly cookies (not readable by JavaScript)
 * - Validates all inputs before sending to server as defense-in-depth
 * - Re-checks session on tab focus (throttled to 30s) for tab sync
 */
import { createContext, useContext, useState, useEffect, useRef } from 'react';
import {
  signInSchema,
  signUpSchema,
  getFirstErrorMessage,
} from '../../shared/validations/authSchema.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';

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
      });
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  /**
   * Signs in a user with email and password via server-side API
   *
   * Purpose: Authenticates existing users through rate-limited server route
   * Connects to: /api/auth/signin for server-side credential validation
   *
   * Security: Validates inputs before API call as defense-in-depth.
   * Server-side route is IP rate-limited to prevent brute force.
   *
   * @param {string} email - User's email address
   * @param {string} password - User's password
   * @returns {Promise<{data: Object|null, error: Object|null}>} Auth result
   */
  const signIn = async (email, password) => {
    const validationResult = signInSchema.safeParse({ email, password });

    if (!validationResult.success) {
      return {
        data: null,
        error: { message: getFirstErrorMessage(validationResult.error) },
      };
    }

    try {
      // Raw fetch (not apiRequest) — signIn is a pre-auth endpoint with
      // csrfProtect: false, so no x-csrf-token header or CSRF retry needed.
      const response = await fetch('/api/auth/signin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: validationResult.data.email,
          password: validationResult.data.password
        })
      });

      const result = await response.json();

      if (!response.ok || result.error) {
        return {
          data: null,
          error: { message: result.message || ERROR_MESSAGES.SIGN_IN_FAILED }
        };
      }

      // Server wrote httpOnly auth cookies — use the user from the response
      // directly instead of making a second request to /api/auth/session.
      setUser(result.data?.user ?? null);
      lastSessionCheckRef.current = Date.now();

      // New session — fetch a fresh CSRF token bound to this user
      fetch('/api/auth/csrf', { credentials: 'same-origin' }).catch(() => {});

      return { data: result.data, error: null };
    } catch (error) {
      return {
        data: null,
        error: { message: 'Network error. Please try again.' }
      };
    }
  };

  /**
   * Creates a new user account via server-side API
   *
   * Purpose: Registers new users through rate-limited server route
   * Connects to: /api/auth/signup for server-side account creation
   *
   * Security: Validates inputs before API call as defense-in-depth.
   * Server-side route is IP rate-limited and enforces password strength.
   *
   * @param {string} email - User's email address
   * @param {string} password - User's password (must meet complexity requirements)
   * @param {string} confirmPassword - Password confirmation (must match password)
   * @returns {Promise<{data: Object|null, error: Object|null}>} Auth result
   */
  const signUp = async (email, password, confirmPassword) => {
    const validationResult = signUpSchema.safeParse({
      email,
      password,
      confirmPassword,
    });

    if (!validationResult.success) {
      return {
        data: null,
        error: { message: getFirstErrorMessage(validationResult.error) },
      };
    }

    try {
      // Raw fetch (not apiRequest) — signUp is a pre-auth endpoint with
      // csrfProtect: false, so no x-csrf-token header or CSRF retry needed.
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: validationResult.data.email,
          password: validationResult.data.password
        })
      });

      const result = await response.json();

      if (!response.ok || result.error) {
        return {
          data: null,
          error: { message: result.message || ERROR_MESSAGES.SIGN_UP_FAILED }
        };
      }

      // Use user from the response directly. Will be null if email
      // confirmation is required (Supabase returns session: null in that case).
      setUser(result.data?.user ?? null);
      lastSessionCheckRef.current = Date.now();

      // Fetch CSRF token if a session was created (no email confirmation required)
      if (result.data?.user) {
        fetch('/api/auth/csrf', { credentials: 'same-origin' }).catch(() => {});
      }

      return { data: result.data, error: null };
    } catch (error) {
      return {
        data: null,
        error: { message: 'Network error. Please try again.' }
      };
    }
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
    signIn,
    signUp,
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
 * @returns {Object} Auth context value (user, loading, signIn, signUp, signOut)
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
