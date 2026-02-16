/**
 * Authentication Context Provider
 *
 * Purpose: Manages authentication state and provides auth methods to the app
 * Connects to:
 * - /api/auth/signin and /api/auth/signup for server-side auth (rate-limited)
 * - Supabase client for session management and auth state listening
 * - authSchema.js for input validation (security safeguard)
 *
 * Security: Validates all inputs before sending to server as a defense-in-depth measure.
 * Auth requests are proxied through the server to enable IP-based rate limiting.
 */
import { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';
import {
  signInSchema,
  signUpSchema,
  getFirstErrorMessage,
} from '../../shared/validations/authSchema.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check active session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  /**
   * Signs in a user with email and password via server-side API
   *
   * Purpose: Authenticates existing users through rate-limited server route
   * Connects to:
   * - /api/auth/signin for server-side credential validation
   * - supabase.auth.setSession() to sync client auth state
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
      const response = await fetch('/api/auth/signin', {
        method: 'POST',
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

      // Sync session with Supabase client so onAuthStateChange fires
      if (result.data?.session) {
        await supabase.auth.setSession({
          access_token: result.data.session.access_token,
          refresh_token: result.data.session.refresh_token
        });
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
   * Creates a new user account via server-side API
   *
   * Purpose: Registers new users through rate-limited server route
   * Connects to:
   * - /api/auth/signup for server-side account creation
   * - supabase.auth.setSession() to sync client auth state
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
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: validationResult.data.email,
          password: validationResult.data.password,
          confirmPassword: validationResult.data.confirmPassword
        })
      });

      const result = await response.json();

      if (!response.ok || result.error) {
        return {
          data: null,
          error: { message: result.message || ERROR_MESSAGES.SIGN_UP_FAILED }
        };
      }

      // Sync session if returned (depends on email confirmation config)
      if (result.data?.session) {
        await supabase.auth.setSession({
          access_token: result.data.session.access_token,
          refresh_token: result.data.session.refresh_token
        });
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
   * Purpose: Ends user session and clears auth state
   *
   * @returns {Promise<{error: Object|null}>} Sign out result
   */
  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
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
