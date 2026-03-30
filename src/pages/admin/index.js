import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../client/contexts/AuthContext';

export default function AdminIndex() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'admin') { router.replace('/'); return; }
    router.replace('/admin/users');
  }, [authLoading, user, router]);

  return null;
}
