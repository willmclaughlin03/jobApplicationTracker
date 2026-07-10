/**
 * Branded error status routes that must stay public and share safe page copy.
 *
 * Purpose: Keep middleware route allowlists and the ErrorPage content mapping
 * on one status-code source so new public error pages cannot drift by layer.
 */
export const ERROR_STATUS_CODES = Object.freeze([403, 404, 429, 500, 502, 503, 504]);
