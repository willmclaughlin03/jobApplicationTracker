import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

const PAGE_SIZE = 25;

/**
 * Fetches and manages the paginated admin user list.
 *
 * Purpose: Provides the admin users list page with user data and mutations.
 * Connects to:
 *   - GET /api/admin/users (paginated, admin-only)
 *   - DELETE /api/admin/users/[id] (admin-only, CSRF-protected)
 *
 * Pagination: hasMore is derived from the total count returned by the API.
 *
 * @param {boolean} [enabled=true] - Set false to suppress fetching until auth is confirmed
 * @returns {{ users, loading, error, page, setPage, hasMore, deleting, deleteUser, clearError }}
 */
export function useAdminUsers({ enabled = true } = {}) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const fetchUsers = useCallback(async (pageNum) => {
    if (!enabled) { setLoading(false); setUsers([]); return; }
    setLoading(true);
    setError(null);

    const { data: body, error: fetchError } = await api.get(
      `/api/admin/users?page=${pageNum}&pageSize=${PAGE_SIZE}`
    );

    if (fetchError || body?.error) {
      setError(body?.message ?? fetchError ?? 'Failed to load users.');
    } else {
      setUsers(body.data.users);
      setHasMore((pageNum * PAGE_SIZE) < body.data.total);
    }

    setLoading(false);
  }, [enabled]);

  useEffect(() => {
    fetchUsers(page);
  }, [page, fetchUsers]);

  /**
   * Deletes a user account. Removes the user from local state on success.
   *
   * @param {string} id - Target user UUID
   * @returns {Promise<{ success: boolean, message?: string }>}
   */
  const deleteUser = useCallback(async (id) => {
    setDeleting(id);

    const { data: body, error: deleteError } = await api.delete(`/api/admin/users/${id}`);

    if (deleteError || body?.error) {
      setDeleting(null);
      return { success: false, message: body?.message ?? deleteError ?? 'Delete failed.' };
    }

    setUsers(prev => prev.filter(u => u.id !== id));
    setDeleting(null);
    return { success: true };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { users, loading, error, page, setPage, hasMore, deleting, deleteUser, clearError };
}
