import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

/**
 * Fetches and manages a single admin user's profile and activity.
 *
 * Purpose: Provides the admin user detail page with profile data, job activity,
 * and role/delete mutations.
 * Connects to:
 *   - GET /api/admin/users/[id] (admin-only)
 *   - PUT /api/admin/users/[id]/role (admin-only, CSRF-protected)
 *   - DELETE /api/admin/users/[id] (admin-only, CSRF-protected)
 *
 * @param {string} id - Target user UUID from the route param
 * @param {boolean} [enabled=true] - Set false to suppress fetching until auth is confirmed
 * @returns {{ user, activity, loading, error, updating, deleting, updateRole, deleteUser, clearError }}
 */
export function useAdminUser(id, { enabled = true } = {}) {
  const [user, setUser] = useState(null);
  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id || !enabled) { setLoading(false); return; }

    let cancelled = false;

    async function fetchUser() {
      setLoading(true);
      setError(null);

      const { data: body, error: fetchError } = await api.get(`/api/admin/users/${id}`);

      if (cancelled) return;

      if (fetchError || body?.error) {
        setError(body?.message ?? fetchError ?? 'Failed to load user.');
      } else {
        setUser(body.data.user);
        setActivity(body.data.activity);
      }

      setLoading(false);
    }

    fetchUser();
    return () => { cancelled = true; };
  }, [id, enabled]);

  /**
   * Updates the target user's role.
   *
   * @param {'admin'|'user'} role - New role value
   * @returns {Promise<{ success: boolean, message?: string }>}
   */
  const updateRole = useCallback(async (role) => {
    setUpdating(true);

    const { data: body, error: updateError } = await api.put(`/api/admin/users/${id}/role`, { role });

    if (updateError || body?.error) {
      setUpdating(false);
      return { success: false, message: body?.message ?? updateError ?? 'Role update failed.' };
    }

    setUser(prev => ({ ...prev, role }));
    setUpdating(false);
    return { success: true };
  }, [id]);

  /**
   * Deletes the target user account.
   *
   * @returns {Promise<{ success: boolean, message?: string }>}
   */
  const deleteUser = useCallback(async () => {
    setDeleting(true);

    const { data: body, error: deleteError } = await api.delete(`/api/admin/users/${id}`);

    if (deleteError || body?.error) {
      setDeleting(false);
      return { success: false, message: body?.message ?? deleteError ?? 'Delete failed.' };
    }

    setDeleting(false);
    return { success: true };
  }, [id]);

  const clearError = useCallback(() => setError(null), []);

  return { user, activity, loading, error, updating, deleting, updateRole, deleteUser, clearError };
}
