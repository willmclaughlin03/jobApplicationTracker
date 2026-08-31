/**
 * SafeUser normalization for authenticated provider users.
 *
 * Purpose: Convert a Supabase user into the only three fields allowed by the
 * public v2 contract while rejecting malformed identity or role data.
 * Connects to: the shared SafeUser schema and future v2 session handling.
 */

import { AUTH_USER_ROLES } from '../../shared/constants/authV2.js';
import { safeUserSchema } from '../../shared/schemas/authV2.js';

/**
 * Resolves the exact application role without coercion, trimming, or folding.
 * Missing metadata or role values safely default to the least-privileged role.
 *
 * @param {unknown} appMetadata provider application metadata
 * @returns {{ok: true, role: 'user'|'admin'}|{ok: false}} normalized role result
 */
function normalizeAuthRole(appMetadata) {
  if (appMetadata === undefined || appMetadata === null) {
    return { ok: true, role: AUTH_USER_ROLES.USER };
  }
  if (typeof appMetadata !== 'object' || Array.isArray(appMetadata)) {
    return { ok: false };
  }

  const rawRole = appMetadata.role;
  if (rawRole === undefined || rawRole === null) {
    return { ok: true, role: AUTH_USER_ROLES.USER };
  }
  if (rawRole === AUTH_USER_ROLES.USER || rawRole === AUTH_USER_ROLES.ADMIN) {
    return { ok: true, role: rawRole };
  }
  return { ok: false };
}

/**
 * Constructs and validates a strict SafeUser without retaining provider data.
 * The function fails closed when provider fields or getters are malformed.
 *
 * @param {unknown} providerUser Supabase user candidate
 * @returns {{ok: true, user: {id: string, email: string|null, role: 'user'|'admin'}}|{ok: false}}
 */
export function normalizeAuthSafeUser(providerUser) {
  try {
    if (typeof providerUser !== 'object' || providerUser === null || Array.isArray(providerUser)) {
      return { ok: false };
    }

    const roleResult = normalizeAuthRole(providerUser.app_metadata);
    if (!roleResult.ok) return { ok: false };

    const parsed = safeUserSchema.safeParse({
      id: providerUser.id,
      email: providerUser.email ?? null,
      role: roleResult.role,
    });

    return parsed.success ? { ok: true, user: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}
