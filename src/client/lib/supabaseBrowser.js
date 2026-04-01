/**
 * Browser-side Supabase client
 *
 * Purpose: Provides a Supabase client for browser-only operations.
 * Currently used exclusively for initiating OAuth redirects via
 * signInWithOAuth — it does NOT read session tokens or manage cookies.
 * All session management (reading user, signing out) continues through
 * the httpOnly-cookie API routes.
 *
 * Connects to:
 * - AuthContext.js signInWithOAuth for Google OAuth redirect initiation
 * - @supabase/ssr createBrowserClient for PKCE challenge generation and
 *   OAuth state management (stored in cookies, not localStorage)
 */
import { createBrowserClient } from '@supabase/ssr';

export const supabaseBrowser = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
