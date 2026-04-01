/**
 * /auth/callback — OAuth PKCE code exchange page
 *
 * Purpose: Client-side bridge that receives the OAuth authorization code from
 * Google via query string, forwards it to the server-side exchange route, then
 * redirects the user to their intended destination (or /) on success.
 *
 * This page exists because OAuth providers redirect the browser here with
 * ?code= in the query string. A client-side page is the minimal bridge to
 * forward the code to the server — the server cannot receive the initial
 * OAuth redirect directly when using Supabase PKCE flow.
 *
 * Flow:
 * 1. Read ?code= from query string; abort with error if absent
 * 2. Read and validate ?next= against open-redirect rules
 * 3. POST { code, next } to /api/auth/oauth-callback with credentials
 * 4. On success → window.location.href = data.next (full navigation so
 *    Next.js middleware picks up the new session cookies)
 * 5. On error → show error card with link back to /login
 *
 * Connects to:
 * - /api/auth/oauth-callback for server-side PKCE exchange
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Spinner from '../../client/components/Spinner';

export default function AuthCallback() {
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(true);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    if (!code) {
      setError('No authorisation code found. Please try signing in again.');
      setProcessing(false);
      return;
    }

    const rawNext = urlParams.get('next');
    const isSafePath =
      typeof rawNext === 'string' &&
      rawNext.startsWith('/') &&
      !rawNext.startsWith('//') &&
      !rawNext.includes('\\');
    const safeNext = isSafePath ? rawNext : '/';

    fetch('/api/auth/oauth-callback', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, next: safeNext }),
    })
      .then(res => {
        if (!res.ok && res.headers.get('content-type')?.includes('application/json') === false) {
          throw new Error(`Server error: ${res.status}`);
        }
        return res.json();
      })
      .then(result => {
        if (result.error) {
          setError(result.message || 'Sign in failed. Please try again.');
          setProcessing(false);
        } else {
          // Use window.location.href (not router.push) to force a full page
          // navigation so Next.js middleware runs and picks up the new session cookies.
          // safeNext is used directly — it was validated client-side and is already in
          // scope; trusting result.data.next would be an unnecessary network trust dependency.
          window.location.href = safeNext;
        }
      })
      .catch(() => {
        setError('Sign in failed. Please try again.');
        setProcessing(false);
      });
  }, []);

  if (processing) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        <Spinner size="lg" className="text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-5">
      <div className="bg-white p-10 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-semibold text-gray-800 mb-4">
          Sign In Failed
        </h1>
        <p className="text-gray-600 mb-6">{error}</p>
        <Link
          href="/login"
          className="block w-full text-center bg-blue-600 text-white py-2.5 px-4 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Try Again
        </Link>
      </div>
    </div>
  );
}
