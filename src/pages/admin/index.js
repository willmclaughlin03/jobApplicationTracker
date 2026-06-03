import { useEffect } from 'react';
import { useRouter } from 'next/router';
import AuthSessionUnavailable from '../../client/components/AuthSessionUnavailable';
import { useAuth } from '../../client/contexts/AuthContext';

export default function AdminIndex() {
  const router = useRouter();
  const { user, loading: authLoading, sessionError, retrySessionCheck } = useAuth();

  useEffect(() => {
    if (sessionError) return;
    if (authLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'admin') { router.replace('/'); return; }
    router.replace('/admin/users');
  }, [authLoading, sessionError, user, router]);

  if (sessionError) {
    return <AuthSessionUnavailable sessionError={sessionError} onRetry={retrySessionCheck} />;
  }

  return null;
}
