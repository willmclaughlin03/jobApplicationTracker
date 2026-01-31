/**
 * Authentication Context Provider
 *
 * Purpose: Manages authentication state and provides auth methods to the app
 * Connects to:
 * - Supabase client for authentication operations
 * - authSchema.js for input validation (security safeguard)
 *
 * Security: Validates all inputs before sending to Supabase as a defense-in-depth measure
 */
import { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';
import {
  signInSchema,
  signUpSchema,
  getFirstErrorMessage,
} from '../../shared/validations/authSchema.js';

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
   * Signs in a user with email and password
   *
   * Purpose: Authenticates existing users
   * Security: Validates inputs before API call as defense-in-depth
   *
   * @param {string} email - User's email address
   * @param {string} password - User's password
   * @returns {Promise<{data: Object|null, error: Object|null}>} Auth result
   */
  const signIn = async (email, password) => {
    // Validate inputs (security safeguard - forms should also validate)
    const validationResult = signInSchema.safeParse({ email, password });

    if (!validationResult.success) {
      return {
        data: null,
        error: { message: getFirstErrorMessage(validationResult.error) },
      };
    }

    // Use sanitized/normalized data from validation
    const { data, error } = await supabase.auth.signInWithPassword({
      email: validationResult.data.email,
      password: validationResult.data.password,
    });
    return { data, error };
  };

  /**
   * Creates a new user account
   *
   * Purpose: Registers new users with validated credentials
   * Security: Enforces strong password policy and sanitizes email
   *
   * @param {string} email - User's email address
   * @param {string} password - User's password (must meet complexity requirements)
   * @param {string} confirmPassword - Password confirmation (must match password)
   * @returns {Promise<{data: Object|null, error: Object|null}>} Auth result
   */
  const signUp = async (email, password, confirmPassword) => {
    // Validate inputs (security safeguard - forms should also validate)
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

    // Use sanitized/normalized data from validation
    const { data, error } = await supabase.auth.signUp({
      email: validationResult.data.email,
      password: validationResult.data.password,
    });
    return { data, error };
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
