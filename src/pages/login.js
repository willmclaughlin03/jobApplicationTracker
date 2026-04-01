import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../client/contexts/AuthContext';

export default function Login() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signInWithOAuth, user, loading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  const handleSignIn = async () => {
    setError('');
    setLoading(true);

    const { error: oauthError } = await signInWithOAuth('google');

    if (oauthError) {
      setError(oauthError.message || 'Failed to initiate sign in.');
      setLoading(false);
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
        <p className="text-gray-500 mb-6">Welcome back to Track The App</p>

        {error && (
          <div className="bg-red-100 text-red-800 p-3 rounded mb-4 text-sm" role="alert">
            {error}
          </div>
        )}

        <button
          type="button"
          className="w-full bg-blue-600 text-white py-2.5 px-4 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
          disabled={loading}
          onClick={handleSignIn}
        >
          {loading ? 'Redirecting...' : 'Continue with Google'}
        </button>
      </div>
    </div>
  );
}
