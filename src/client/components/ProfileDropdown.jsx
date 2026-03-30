import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';

/**
 * ProfileDropdown component
 *
 * Purpose: Displays user email with a dropdown menu for profile actions
 * Connects to:
 * - /api/auth/forgot-password for server-side, rate-limited password reset emails
 * - Parent component (index.js) for user data and sign-out handler
 *
 * @param {Object} props
 * @param {Object} props.user - Supabase user object (must have .email)
 * @param {Function} props.onSignOut - Callback to sign out and redirect
 */
export default function ProfileDropdown({ user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [resetStatus, setResetStatus] = useState(null);
  const [resetLoading, setResetLoading] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleResetPassword = async () => {
    setResetLoading(true);
    setResetStatus(null);

    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        setResetStatus({ type: 'success', message: 'Password reset link sent to your email.' });
      } else {
        setResetStatus({ type: 'error', message: result.message || 'Failed to send reset email. Please try again.' });
      }
    } catch {
      setResetStatus({ type: 'error', message: 'Something went wrong. Please try again.' });
    }

    setResetLoading(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => { setOpen(!open); setResetStatus(null); }}
        className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-800 transition-colors px-3 py-2 rounded-md hover:bg-gray-100"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="hidden sm:inline">{user?.email}</span>
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-xs text-gray-500">Signed in as</p>
            <p className="text-sm font-medium text-gray-800 truncate">{user?.email}</p>
          </div>

          <div className="p-2">
            {user?.role === 'admin' && (
              <Link
                href="/admin/users"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-sm text-orange-600 hover:bg-orange-50 rounded-md transition-colors"
              >
                Admin
              </Link>
            )}

            <button
              onClick={handleResetPassword}
              disabled={resetLoading}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              {resetLoading ? 'Sending...' : 'Reset Password'}
            </button>

            {resetStatus && (
              <p className={`px-3 py-1.5 text-xs ${resetStatus.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {resetStatus.message}
              </p>
            )}

            <button
              onClick={onSignOut}
              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-md transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
