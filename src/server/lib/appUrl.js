const APP_ORIGIN_ENV_VAR = 'NEXT_PUBLIC_APP_URL';
const LOCAL_DEVELOPMENT_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Create the shared configuration error type for app URL guards.
 *
 * Purpose: route-level Stripe redirects need a stable config error shape while
 * still resolving the app origin lazily, after emergency halt checks can run.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createAppUrlConfigError(message) {
  const error = new Error(message);
  error.code = 'STRIPE_CONFIG_INVALID';
  return error;
}

/**
 * Normalize environment and pathname string inputs.
 *
 * Purpose: app URL validation should treat whitespace-only, absent, and
 * non-string values consistently before parsing or path checks run.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAppUrlValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate the server-configured app origin used for Stripe redirect URLs.
 *
 * Purpose: Keep checkout and billing-portal return URLs pinned to one trusted
 * deployment origin that is validated lazily instead of being inferred from
 * request headers.
 *
 * @param {unknown} rawOrigin
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function validateAppOrigin(rawOrigin, env = process.env) {
  const normalizedOrigin = normalizeAppUrlValue(rawOrigin);

  if (!normalizedOrigin) {
    throw createAppUrlConfigError(`Missing ${APP_ORIGIN_ENV_VAR} environment variable`);
  }

  let parsedOrigin;

  try {
    parsedOrigin = new URL(normalizedOrigin);
  } catch {
    throw createAppUrlConfigError(`Invalid ${APP_ORIGIN_ENV_VAR} environment variable`);
  }

  if (
    parsedOrigin.pathname !== '/'
    || parsedOrigin.search
    || parsedOrigin.hash
    || parsedOrigin.username
    || parsedOrigin.password
    || !parsedOrigin.hostname
  ) {
    throw createAppUrlConfigError(`Invalid ${APP_ORIGIN_ENV_VAR} environment variable`);
  }

  const isProduction = env?.NODE_ENV === 'production';
  const protocol = parsedOrigin.protocol;
  const isLocalDevelopmentOrigin = LOCAL_DEVELOPMENT_HOSTNAMES.has(parsedOrigin.hostname);

  if (protocol === 'https:') {
    return parsedOrigin.origin;
  }

  if (!isProduction && protocol === 'http:' && isLocalDevelopmentOrigin) {
    return parsedOrigin.origin;
  }

  throw createAppUrlConfigError(`Invalid ${APP_ORIGIN_ENV_VAR} environment variable`);
}

/**
 * Return the validated app origin used for Stripe redirect URLs.
 *
 * Purpose: callers resolve the app origin only when they need to build a
 * redirect URL, keeping module imports independent of app URL configuration.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function getAppOrigin(env = process.env) {
  return validateAppOrigin(env?.[APP_ORIGIN_ENV_VAR], env);
}

/**
 * Build an absolute app URL rooted at the validated deployment origin.
 *
 * Purpose: checkout and portal flows must never trust request host headers when
 * constructing return URLs, so this helper pins redirect construction to the
 * server-configured origin.
 *
 * @param {string} pathname
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildAppUrl(pathname, env = process.env) {
  const appOrigin = getAppOrigin(env);
  const normalizedPathname = normalizeAppUrlValue(pathname);

  if (
    !normalizedPathname
    || !normalizedPathname.startsWith('/')
    || normalizedPathname.startsWith('//')
  ) {
    throw createAppUrlConfigError('Invalid app pathname');
  }

  const url = new URL(normalizedPathname, `${appOrigin}/`);

  if (url.origin !== appOrigin) {
    throw createAppUrlConfigError('Invalid app pathname');
  }

  return url.toString();
}
