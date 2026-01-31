import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '../client/contexts/AuthContext';
import { signInSchema, getFieldErrors } from '../shared/validations/authSchema';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const { signIn, user, loading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  /**
   * Validates form data using Zod schema
   * Returns true if valid, false otherwise
   * Sets field-level errors for display
   */
  const validateForm = () => {
    const result = signInSchema.safeParse({ email, password });

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

  /**
   * Clears field error when user starts typing
   */
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

    // Validate form before submission
    if (!validateForm()) {
      return;
    }

    setLoading(true);

    const { error: signInError } = await signIn(email, password);

    if (signInError) {
      setError(signInError.message || 'Failed to sign in');
      setLoading(false);
    } else {
      router.push('/');
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Loading...
      </div>
    );
  }

  if (user) {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-5">
      <div className="bg-white p-10 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Sign In</h1>
        <p className="text-gray-500 mb-6">Welcome back to Job Tracker</p>

        {error && !Object.keys(fieldErrors).length && (
          <div className="bg-red-100 text-red-800 p-3 rounded mb-4 text-sm" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-4">
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => handleFieldChange('email', e.target.value, setEmail)}
              required
              placeholder="Enter your email"
              aria-invalid={!!fieldErrors.email}
              aria-describedby={fieldErrors.email ? 'email-error' : undefined}
              className={`w-full px-3 py-2.5 border rounded text-sm focus:outline-none transition-colors ${
                fieldErrors.email
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:border-blue-500'
              }`}
            />
            {fieldErrors.email && (
              <p id="email-error" className="text-red-600 text-xs mt-1">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div className="mb-4">
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => handleFieldChange('password', e.target.value, setPassword)}
              required
              placeholder="Enter your password"
              aria-invalid={!!fieldErrors.password}
              aria-describedby={fieldErrors.password ? 'password-error' : undefined}
              className={`w-full px-3 py-2.5 border rounded text-sm focus:outline-none transition-colors ${
                fieldErrors.password
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:border-blue-500'
              }`}
            />
            {fieldErrors.password && (
              <p id="password-error" className="text-red-600 text-xs mt-1">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 text-white py-2.5 px-4 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
            disabled={loading}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="text-center mt-5 text-gray-500 text-sm">
          Don't have an account?{' '}
          <Link href="/signUp" className="text-blue-600 hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
