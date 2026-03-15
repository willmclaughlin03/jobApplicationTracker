/**
 * /auth/callback — Password recovery token exchange page
 *
 * Purpose: Reads the #access_token hash fragment from Supabase's password
 * reset email link and POSTs the tokens to /api/auth/exchange-token for
 * secure httpOnly cookie session establishment.
 *
 * This page exists because URL hash fragments (RFC 3986) never reach the
 * server — the browser must forward them via JavaScript. This is the
 * minimal JS needed; it does NOT import the Supabase browser client.
 *
 * Flow:
 * 1. User clicks password reset link in email
 * 2. Supabase redirects to /auth/callback?next=/reset-password#access_token=...
 * 3. This page reads the hash, POSTs tokens to exchange-token endpoint
 * 4. On success, redirects to the `next` query param (e.g. /reset-password)
 * 5. On failure, shows error with link to request a new reset
 *
 * Connects to:
 * - /api/auth/exchange-token for server-side token exchange
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Spinner from '../../client/components/Spinner';

export default function AuthCallback() {
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(true);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) {
      setError('No recovery token found. This link may be invalid or expired.');
      setProcessing(false);
      return;
    }

    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (!accessToken || !refreshToken) {
      setError('Incomplete recovery token. Please request a new password reset link.');
      setProcessing(false);
      return;
    }

    // Read the redirect destination from the query string
    const urlParams = new URLSearchParams(window.location.search);
    const next = urlParams.get('next') || '/reset-password';

    // Validate next is a relative path to prevent open redirect
    const safeNext = next.startsWith('/') ? next : '/reset-password';

    // Clear the hash immediately to avoid token exposure in browser history
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    fetch('/api/auth/exchange-token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken
      })
    })
      .then(res => res.json())
      .then(result => {
        if (result.error) {
          setError(result.message || 'Failed to verify reset link. Please request a new one.');
          setProcessing(false);
        } else {
          // Session established via httpOnly cookies — redirect to destination
          window.location.href = safeNext;
        }
      })
      .catch(() => {
        setError('Network error. Please try again.');
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
        <h1 className="text-2xl font-semibold text-gray-800 mb-4">Link Expired or Invalid</h1>
        <p className="text-gray-600 mb-6">{error}</p>
        <Link
          href="/forgot-password"
          className="block w-full text-center bg-blue-600 text-white py-2.5 px-4 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Request New Link
        </Link>
      </div>
    </div>
  );
}
