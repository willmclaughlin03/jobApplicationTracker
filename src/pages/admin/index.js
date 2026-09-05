import { applyProtectedPageCache } from '../../server/lib/protectedPageCache.js';

/**
 * Opt this protected shell into request-time rendering and prevent CDN storage.
 * Middleware and existing client/API guards retain their authentication duties;
 * no user data or credentials are serialized into props by this cache boundary.
 * @param {import('next').GetServerSidePropsContext} context - Page response.
 * @returns {Promise<{props: object}>} Empty props for the existing client shell.
 */
export async function getServerSideProps({ res }) {
  applyProtectedPageCache(res);
  return { props: {} };
}

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
