const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const COOKIE_NAME = 'sb-127-auth-token';
const USERS = Object.freeze({
  admin: { id: '10000000-0000-4000-8000-000000000001', app_metadata: { role: 'admin' } },
  member: { id: '20000000-0000-4000-8000-000000000002', app_metadata: { role: 'user' } },
});

/** Fail with an explicitly safe assertion message, never received token/body data. */
function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

/** Encode synthetic JSON in the format consumed by the real SSR SDK storage. */
function encodeFixture(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Listen only on loopback, using an ephemeral port. This fixture supplies the
 * external Auth HTTP protocol; application/SDK/middleware modules stay real.
 * @returns {Promise<object>} Provider, synthetic session factory, safe observations.
 */
async function startFixtureProvider() {
  const access = new Map();
  const refresh = new Map();
  const observations = [];

  /** Issue synthetic SDK-readable sessions, with tokens retained only in memory. */
  function issueSession(profile, { expired = false, invalid = false, failUser = false, failUserAfter = Infinity, chunked = false } = {}) {
    ensure(Object.hasOwn(USERS, profile), 'Unknown fixture profile.');
    const user = { ...USERS[profile], aud: 'authenticated', role: 'authenticated',
      created_at: '2026-01-01T00:00:00.000Z', user_metadata: {} };
    const expiresAt = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
    const token = `${encodeFixture({ alg: 'HS256', typ: 'JWT' })}.${encodeFixture({
      sub: user.id, exp: expiresAt, role: 'authenticated', aud: 'authenticated',
      fixture: randomBytes(12).toString('hex'),
    })}.${randomBytes(32).toString('base64url')}`;
    const refreshToken = randomBytes(24).toString('hex');
    access.set(token, { profile, failUser, failUserAfter, reads: 0, user, generation: expired ? 'expired' : 'fresh' });
    refresh.set(refreshToken, { profile, invalid, failUser, failUserAfter });
    const session = { access_token: token, refresh_token: refreshToken,
      expires_at: expiresAt, expires_in: expired ? -3600 : 3600, token_type: 'bearer', user };
    const encoded = `base64-${encodeFixture(session)}`;
    const jar = new Map();
    if (chunked) {
      const middle = Math.ceil(encoded.length / 2);
      jar.set(`${COOKIE_NAME}.0`, encoded.slice(0, middle));
      jar.set(`${COOKIE_NAME}.1`, encoded.slice(middle));
      // A non-contiguous obsolete chunk must also be removed by SDK storage writes.
      jar.set(`${COOKIE_NAME}.5`, 'obsolete-synthetic-chunk');
    } else jar.set(COOKIE_NAME, encoded);
    return { session, jar };
  }

  /** Serialize only protocol fixture bodies; request credentials are never logged. */
  function respond(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }

  /** Handle only known Auth endpoints, bounding request bodies and fixture state. */
  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
      const state = access.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (state) state.reads++;
      const failed = !state || state.failUser || state.reads > state.failUserAfter;
      observations.push({ operation: 'user', profile: state?.profile ?? 'unknown',
        generation: state?.generation ?? 'unknown', failed });
      if (failed) {
        respond(res, 401, { code: 'bad_jwt', message: 'Synthetic authentication failure' });
      } else respond(res, 200, state.user);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/token'
        && url.searchParams.get('grant_type') === 'refresh_token') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) { respond(res, 413, {}); return; }
      }
      let supplied;
      try { supplied = JSON.parse(body); } catch { respond(res, 400, {}); return; }
      const state = refresh.get(supplied.refresh_token);
      observations.push({ operation: 'refresh', profile: state?.profile ?? 'unknown', failed: !state || state.invalid });
      if (!state || state.invalid) {
        respond(res, 400, { code: 'refresh_token_not_found', message: 'Synthetic invalid refresh' });
      } else {
        // Reject reuse: a second refresh during downstream SSR exposes forwarding bugs.
        refresh.delete(supplied.refresh_token);
        respond(res, 200, issueSession(state.profile, {
          failUser: state.failUser, failUserAfter: state.failUserAfter,
        }).session);
      }
      return;
    }
    respond(res, 404, { message: 'Unsupported fixture endpoint' });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => respond(res, 500, { message: 'Fixture request failed' }));
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, issueSession, observations,
    /** Resolve final cookie state locally without retaining or printing token values. */
    identify(jar) {
      let encoded = jar.get(COOKIE_NAME) || '';
      if (!encoded) {
        for (let index = 0; jar.has(`${COOKIE_NAME}.${index}`); index++) encoded += jar.get(`${COOKIE_NAME}.${index}`);
      }
      if (!encoded) return null;
      try {
        const session = JSON.parse(Buffer.from(encoded.replace(/^base64-/, ''), 'base64url').toString());
        return access.get(session.access_token)?.profile ?? null;
      } catch { return null; }
    },
    /** Close this owned server and clear all synthetic credentials after each run. */
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      access.clear();
      refresh.clear();
      observations.length = 0;
    },
  };
}

/**
 * Build an allowlisted child environment, excluding real service credentials.
 * Synthetic builds are local composition tests, never deployment evidence.
 * @param {object} inherited - OS environment (values are never printed).
 * @param {string} providerUrl - This run's loopback Auth fixture endpoint.
 * @returns {object} Child-process environment with synthetic application config.
 */
function fixtureEnvironment(inherited, providerUrl) {
  const url = new URL(providerUrl);
  ensure(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'Fixture provider must be loopback HTTP.');
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive',
    'temp', 'tmp', 'appdata', 'localappdata', 'userprofile', 'home']);
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => allowed.has(key.toLowerCase()))),
    NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: providerUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-runtime-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-runtime-service',
    CSRF_SECRET: 'synthetic-runtime-csrf-at-least-32-characters',
    BILLING_CHECKOUT_DISABLED: 'true',
  };
}

/**
 * Apply final serialized response cookies to an isolated HTTP-test cookie jar.
 * Verify production auth attributes; browser Secure acceptance remains a manual
 * HTTPS check. Do not comma-split Set-Cookie, which can contain Expires dates.
 * @param {Map} jar - One fixture profile's cookies, retained only in memory.
 * @param {string[]} cookies - Actual separate final Set-Cookie header values.
 * @returns {object} Separate non-deletion write and deletion counts, never cookie values.
 */
function applyResponseCookies(jar, cookies) {
  let deletions = 0;
  for (const cookie of cookies) {
    const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    ensure(separator > 0, 'Malformed final cookie.');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const normalized = attributes.map((attribute) => attribute.toLowerCase());
    ensure(name === COOKIE_NAME || name.startsWith(`${COOKIE_NAME}.`), 'Unexpected fixture cookie writer.');
    ensure(normalized.includes('httponly') && normalized.includes('secure')
      && normalized.includes('samesite=lax') && normalized.includes('path=/'), 'Auth cookie attributes changed.');
    if (normalized.includes('max-age=0')) {
      ensure(value === '', 'Deletion cookie must have empty value.');
      jar.delete(name);
      deletions++;
    } else {
      ensure(normalized.some((attribute) => /^max-age=[1-9]\d*$/.test(attribute)), 'Refresh cookie lifetime missing.');
      jar.set(name, value);
    }
  }
  return { writes: cookies.length - deletions, deletions };
}

/** Check actual final page/data cache headers, without returning response content. */
function assertPrivateResponse(response) {
  ensure(response.headers.get('cache-control') === 'private, no-store', 'Final private no-store policy missing.');
  ensure(response.headers.get('cdn-cache-control') === 'no-store', 'Final CDN no-store policy missing.');
  ensure(response.headers.get('vercel-cdn-cache-control') === 'no-store', 'Local Vercel CDN no-store policy missing.');
}

/** Send a bounded real HTTP document/data request without forcing cache bypass. */
async function requestPage(base, pathname, jar, data = false) {
  ensure(new URL(base).hostname === '127.0.0.1', 'Runtime harness accepts only loopback targets.');
  const headers = {};
  if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  if (data) headers['x-nextjs-data'] = '1';
  return fetch(`${base}${pathname}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
}

/**
 * Spawn only the installed Next CLI as an owned hidden subprocess. Capture safe
 * error flags, discard raw output, and provide bounded waits/cleanup to callers.
 * @param {string} root - Locked-install worktree root.
 * @param {string[]} args - Next CLI build/start arguments.
 * @param {object} env - Allowlisted synthetic child environment.
 * @returns {object} Owned child lifecycle and sanitized error flags.
 */
function spawnNext(root, args, env) {
  const flags = { moduleFailure: false };
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), ...args], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const signatures = ['ERR_REQUIRE_ESM', 'Failed to load external module', 'Cannot find module'];
  /** Keep only numeric signature-prefix lengths between chunks, independently per stream. */
  function createInspector() {
    const matched = signatures.map(() => 0);
    /** Inspect transient chunk text, updating match lengths and the shared failure flag. */
    return function inspect(chunk) {
      if (flags.moduleFailure) return;
      const text = chunk.toString();
      for (let index = 0; index < signatures.length; index += 1) {
        const signature = signatures[index];
        const candidate = signature.slice(0, matched[index]) + text;
        if (candidate.includes(signature)) {
          flags.moduleFailure = true;
          matched.fill(0);
          return;
        }
        let length = Math.min(signature.length - 1, candidate.length);
        while (length > 0 && !candidate.endsWith(signature.slice(0, length))) length -= 1;
        matched[index] = length;
      }
    };
  }
  child.stdout.on('data', createInspector());
  child.stderr.on('data', createInspector());
  const ended = new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(code ?? -1));
  });
  return {
    flags,
    /** Bound build/runtime waits and always clear the timeout handle. */
    async wait(timeoutMs) {
      let timer;
      try {
        return await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(() => resolve(-2), timeoutMs); })]);
      } finally { clearTimeout(timer); }
    },
    /** Terminate this owned Next process, escalating on timeout before stream cleanup. */
    async stop() {
      if (child.exitCode === null) child.kill();
      if (await this.wait(5000) === -2) child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

module.exports = {
  COOKIE_NAME, ensure, startFixtureProvider, fixtureEnvironment,
  applyResponseCookies, assertPrivateResponse, requestPage, spawnNext,
};
