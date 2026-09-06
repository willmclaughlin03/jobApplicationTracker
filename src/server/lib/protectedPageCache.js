import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';

/**
 * Prevent storage of a protected Pages Router response at every cache layer.
 * Called before SSR work; changes only cache headers on the supplied Node
 * response, preserving cookies, status, security headers, and response body.
 * This is cache policy, not authentication or authorization.
 * @param {import('http').ServerResponse} res - Request-scoped page response.
 * @returns {void}
 */
export function applyProtectedPageCache(res) {
  res.setHeader('Cache-Control', PRIVATE_NO_STORE);
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
}
