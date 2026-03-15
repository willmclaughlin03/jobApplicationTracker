import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '../client/contexts/AuthContext';
import { api } from '../client/lib/api';
import {
  resetPasswordSchema,
  getPasswordStrength,
  getFieldErrors,
  STRENGTH_LEVELS,
} from '../shared/validations/authSchema';

/**
 * Password strength indicator component
 * Reused from signUp.js pattern
 */
function PasswordStrengthIndicator({ strength }) {
  const config = {
    [STRENGTH_LEVELS.WEAK]: {
      width: 'w-1/4',
      color: 'bg-red-500',
      label: 'Weak',
      textColor: 'text-red-600',
    },
    [STRENGTH_LEVELS.FAIR]: {
      width: 'w-2/4',
      color: 'bg-yellow-500',
      label: 'Fair',
      textColor: 'text-yellow-600',
    },
    [STRENGTH_LEVELS.GOOD]: {
      width: 'w-3/4',
      color: 'bg-blue-500',
      label: 'Good',
      textColor: 'text-blue-600',
    },
    [STRENGTH_LEVELS.STRONG]: {
      width: 'w-full',
      color: 'bg-green-500',
      label: 'Strong',
      textColor: 'text-green-600',
    },
  };

  const { width, color, label, textColor } = config[strength] || config[STRENGTH_LEVELS.WEAK];

  return (
    <div className="mt-2">
      <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full ${width} ${color} transition-all duration-300`}
        />
      </div>
      <p className={`text-xs mt-1 ${textColor}`}>
        Password strength: {label}
      </p>
    </div>
  );
}

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const { user, loading: authLoading } = useAuth();

  const passwordStrength = useMemo(
    () => getPasswordStrength(password),
    [password]
  );

  const validateForm = () => {
    const result = resetPasswordSchema.safeParse({ password, confirmPassword });

    if (!result.success) {
      const errors = getFieldErrors(result.error);
      setFieldErrors(errors);
      setError(result.error.issues[0].message);
      return false;
    }

    setFieldErrors({});
    setError('');
    return true;
  };

  const handleFieldChange = (field, value, setter) => {
    setter(value);
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const updated = { ...prev };
        delete updated[field];
        return updated;
      });
    }
    if (error) setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      const { data, error: fetchError } = await api.post('/api/auth/reset-password', { password });

      if (fetchError) {
        setError(fetchError);
      } else if (data?.error) {
        setError(data.message || 'Failed to update password. Please try again.');
      } else {
        setSuccess(true);
      }
    } catch {
      setError('Network error. Please try again.');
    }

    setLoading(false);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Loading...
      </div>
    );
  }

  // User must be authenticated (Supabase sets session via the email link)
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 p-5">
        <div className="bg-white p-10 rounded-lg shadow-md w-full max-w-md">
          <h1 className="text-2xl font-semibold text-gray-800 mb-4">Invalid or Expired Link</h1>
          <p className="text-gray-600 mb-6">
            This password reset link is invalid or has expired. Please request a new one.
          </p>
          <Link href="/forgot-password" className="block w-full text-center bg-blue-600 text-white py-2.5 px-4 rounded text-sm font-medium hover:bg-blue-700 transition-colors">
            Request New Link
          </Link>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 p-5">
        <div className="bg-white p-10 rounded-lg shadow-md w-full max-w-md">
          <h1 className="text-2xl font-semibold text-gray-800 mb-4">Password Updated</h1>
          <p className="text-gray-600 mb-6">
            Your password has been successfully updated. You can now sign in with your new password.
          </p>
          <Link href="/login" className="block w-full text-center bg-blue-600 text-white py-2.5 px-4 rounded text-sm font-medium hover:bg-blue-700 transition-colors">
            Sign In
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-5">
      <div className="bg-white p-10 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Set New Password</h1>
        <p className="text-gray-500 mb-6">Enter your new password below</p>

        {error && !Object.keys(fieldErrors).length && (
          <div className="bg-red-100 text-red-800 p-3 rounded mb-4 text-sm" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-4">
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1.5">
              New Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => handleFieldChange('password', e.target.value, setPassword)}
              required
              placeholder="Create a new password"
              aria-invalid={!!fieldErrors.password}
              aria-describedby={fieldErrors.password ? 'password-error' : 'password-requirements'}
              className={`w-full px-3 py-2.5 border rounded text-sm focus:outline-none transition-colors ${
                fieldErrors.password
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:border-blue-500'
              }`}
            />
            {fieldErrors.password ? (
              <p id="password-error" className="text-red-600 text-xs mt-1">
                {fieldErrors.password}
              </p>
            ) : (
              <p id="password-requirements" className="text-gray-500 text-xs mt-1">
                Min 12 characters with uppercase, lowercase, number, and special character
              </p>
            )}
            {password && <PasswordStrengthIndicator strength={passwordStrength} />}
          </div>

          <div className="mb-4">
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1.5">
              Confirm New Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => handleFieldChange('confirmPassword', e.target.value, setConfirmPassword)}
              required
              placeholder="Confirm your new password"
              aria-invalid={!!fieldErrors.confirmPassword}
              aria-describedby={fieldErrors.confirmPassword ? 'confirm-error' : undefined}
              className={`w-full px-3 py-2.5 border rounded text-sm focus:outline-none transition-colors ${
                fieldErrors.confirmPassword
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:border-blue-500'
              }`}
            />
            {fieldErrors.confirmPassword && (
              <p id="confirm-error" className="text-red-600 text-xs mt-1">
                {fieldErrors.confirmPassword}
              </p>
            )}
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 text-white py-2.5 px-4 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
            disabled={loading}
          >
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
