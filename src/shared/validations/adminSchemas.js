import { z } from 'zod';

/**
 * Validates the `id` path parameter for admin user endpoints
 * Purpose: Reject non-UUID values before they reach Supabase
 */
export const userIdParamSchema = z.object({
    id: z.string().uuid('Invalid user ID format'),
});

/**
 * Validates the role payload for PUT /api/admin/users/[id]/role
 * Purpose: Restrict role assignments to the defined allowlist
 */
export const setRoleSchema = z.object({
    role: z.enum(['admin', 'user'], { error: "Role must be 'admin' or 'user'" }),
});

/**
 * Validates pagination query params for GET /api/admin/users
 * Purpose: Bound page size to prevent oversized Supabase auth list calls
 */
export const listUsersQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(50),
});
