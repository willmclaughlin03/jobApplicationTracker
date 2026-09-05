import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  COOKIE_NAME, ensure, startFixtureProvider, fixtureEnvironment,
  applyResponseCookies, assertPrivateResponse, requestPage, spawnNext,
} = require('../src/testSupport/protectedPageRuntimeHarness.js');
const { checkProtectedPageBuild } = require('./check-protected-page-build.js');
const { runBuildEnvironmentPreflight } = require('./validate-build-env.js');

/** Allocate a loopback port without ever stopping an unrelated listening process. */
async function allocatePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Wait for this exact build to serve login; no cookie or body content is retained. */
async function waitForServer(base, nextBuildId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await requestPage(base, '/login', new Map());
      if (response.status === 200 && (await response.text()).includes(`"buildId":"${nextBuildId}"`)) return;
    } catch { /* Bounded retries while the owned server starts. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Owned Next server did not serve the expected build.');
}

/** Resolve the concrete document/data URL from the checked build's route manifest. */
function requestPath(route, data, buildId, manifest) {
  const concrete = route.replace('[id]', '550e8400-e29b-41d4-a716-446655440000');
  if (!data) return concrete;
  const pathname = `/_next/data/${buildId}${concrete === '/' ? '/index' : concrete}.json`;
  const entry = manifest.dataRoutes.find((candidate) => candidate.page === route);
  ensure(entry && new RegExp(entry.dataRouteRegex).test(pathname), 'Data request does not match build manifest.');
  return pathname;
}

/** Verify redirect transport at the actual framework boundary, not a mock response. */
async function assertLoginRedirect(response, data, ssr = false) {
  if (data && ssr) {
    const body = await response.json();
    ensure(response.status === 200 && body.pageProps?.__N_REDIRECT === '/login', 'SSR data redirect metadata changed.');
  } else if (data) {
    ensure([200, 307].includes(response.status), 'Middleware data redirect status changed.');
    ensure(response.headers.get('x-nextjs-redirect') === '/login', 'Missing middleware data redirect header.');
    ensure(!response.headers.has('location'), 'Middleware data redirect incorrectly uses Location.');
    await response.arrayBuffer();
  } else {
    ensure(response.status === 307 && new URL(response.headers.get('location'), 'http://127.0.0.1').pathname === '/login', 'Document login redirect changed.');
    await response.arrayBuffer();
  }
}

/**
 * Run actual Next HTTP composition checks with synthetic Auth responses only.
 * This rebuilds .next with a loopback endpoint; do not deploy that artifact.
 * Browser navigation, cookie acceptance, Vercel CDN, and live identity isolation
 * remain mandatory user-run qualification and are explicitly not asserted here.
 */
async function main() {
  const root = process.cwd();
  ensure(!fs.readdirSync(root).some((name) => name === '.env' || name.startsWith('.env.')), 'Use a clean worktree without environment files for synthetic qualification.');
  ensure(process.versions.node.split('.')[0] === '22', 'Run qualification with the approved Node 22 runtime.');
  const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  ensure(require(path.join(root, 'node_modules/next/package.json')).version === declared.dependencies.next,
    'Installed Next differs from the declared security pin.');
  const provider = await startFixtureProvider();
  let build;
  let server;
  const results = [];
  try {
    const env = fixtureEnvironment(process.env, provider.url);
    ensure(runBuildEnvironmentPreflight(env), 'Synthetic build preflight failed.');
    process.stdout.write('Building a synthetic-config production artifact for local HTTP composition only.\n');
    build = spawnNext(root, ['build'], env);
    ensure(await build.wait(240000) === 0, 'Synthetic production build failed or timed out; raw logs withheld.');
    ensure(!build.flags.moduleFailure, 'Module-load failure in synthetic build.');
    const summary = checkProtectedPageBuild(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.next/routes-manifest.json'), 'utf8'));
    const port = await allocatePort();
    const base = `http://127.0.0.1:${port}`;
    server = spawnNext(root, ['start', '--hostname', '127.0.0.1', '--port', String(port)], env);
    await waitForServer(base, summary.nextBuildId);

    for (const data of [false, true]) {
      const transport = data ? 'data-http' : 'document-http';
      const jars = {
        admin: provider.issueSession('admin').jar,
        member: provider.issueSession('member').jar,
        anonymous: new Map(),
      };
      for (const route of summary.protectedRoutes) {
        const pathname = requestPath(route, data, summary.nextBuildId, manifest);
        for (const profile of ['admin', 'member', 'admin', 'anonymous', 'member', 'admin', 'member', 'anonymous']) {
          const response = await requestPage(base, pathname, jars[profile], data);
          assertPrivateResponse(response);
          ensure(response.headers.getSetCookie().length === 0, 'Unexpired session unexpectedly wrote cookies.');
          if (profile === 'anonymous') await assertLoginRedirect(response, data);
          else {
            const expected = route === '/admin/users' && profile === 'member' ? 403 : 200;
            ensure(response.status === expected, `Unexpected ${transport} access result for ${route}.`);
            if (expected === 403) ensure((await response.json()).error === 'ADMIN_FORBIDDEN', 'Admin denial body changed.');
            else await response.arrayBuffer();
            ensure(provider.identify(jars[profile]) === profile, 'Fixture identity changed across users.');
          }
        }
        results.push({ transport, route, scenario: 'unexpired-three-profiles-both-orders', passed: true });
      }

      const cases = [
        { name: 'refresh-admin', profile: 'admin', options: { expired: true, chunked: true }, expected: 200 },
        { name: 'refresh-member-denied', profile: 'member', options: { expired: true, chunked: true }, expected: 403 },
        { name: 'invalid-chunks-deleted', profile: 'member', options: { expired: true, invalid: true, chunked: true }, redirect: true, deleted: true },
        { name: 'writes-then-middleware-auth-failure', profile: 'admin', options: { expired: true, failUser: true, chunked: true }, redirect: true },
        { name: 'writes-then-ssr-auth-failure', profile: 'admin', options: { expired: true, failUserAfter: 1, chunked: true }, redirect: true, ssr: true },
      ];
      for (const scenario of cases) {
        const { jar } = provider.issueSession(scenario.profile, scenario.options);
        const observationStart = provider.observations.length;
        const pathname = requestPath('/admin/users', data, summary.nextBuildId, manifest);
        const response = await requestPage(base, pathname, jar, data);
        assertPrivateResponse(response);
        const counts = applyResponseCookies(jar, response.headers.getSetCookie());
        ensure((scenario.deleted ? counts.writes === 0 : counts.writes > 0) && counts.deletions >= 3,
          'Required refresh/obsolete-chunk cookies were lost.');
        for (const chunk of [0, 1, 5]) ensure(!jar.has(`${COOKIE_NAME}.${chunk}`), 'Obsolete chunk survived final response.');
        const observations = provider.observations.slice(observationStart);
        ensure(observations.filter((entry) => entry.operation === 'refresh').length === 1, 'Downstream SSR repeated refresh; updated cookies were not forwarded.');
        if (scenario.redirect) await assertLoginRedirect(response, data, scenario.ssr);
        else {
          ensure(response.status === scenario.expected, 'Refreshed admin authorization changed.');
          if (scenario.expected === 403) ensure((await response.json()).error === 'ADMIN_FORBIDDEN', 'Refreshed member bypassed admin denial.');
          else await response.arrayBuffer();
          ensure(observations.filter((entry) => entry.operation === 'user'
            && entry.generation === 'fresh' && !entry.failed && entry.profile === scenario.profile).length >= 2,
          'Middleware and downstream SSR did not validate the refreshed identity.');
        }
        if (scenario.deleted) ensure(provider.identify(jar) === null && jar.size === 0, 'Invalid session was not cleared.');
        const followup = await requestPage(base, pathname, jar, data);
        assertPrivateResponse(followup);
        ensure(followup.headers.getSetCookie().length === 0, 'Follow-up unexpectedly refreshed again.');
        if (scenario.redirect) await assertLoginRedirect(followup, data);
        else {
          ensure(followup.status === scenario.expected && provider.identify(jar) === scenario.profile, 'Follow-up session continuity failed.');
          await followup.arrayBuffer();
        }
        results.push({ transport, route: '/admin/users', scenario: scenario.name, ...counts, passed: true });
      }
    }
    ensure(!server.flags.moduleFailure, 'Runtime module-load failure detected.');
    process.stdout.write(`${JSON.stringify({ scope: 'local-synthetic-http-only', nextBuildId: summary.nextBuildId,
      results, browser: 'not executed; user-owned', deployed: 'not executed' }, null, 2)}\n`);
  } finally {
    if (server) await server.stop();
    if (build) await build.stop();
    await provider.close();
  }
}

main().catch((error) => {
  // Only controlled assertion messages are useful; never serialize stacks,
  // response bodies, cookies, fetch errors, child logs, or environment snapshots.
  const safe = /^(Synthetic|Owned|Run qualification|Installed|Use a clean|Module-load|Runtime module|Final |Local Vercel|Unexpected (document|data)-http|Unexpired|Fixture identity|Missing middleware|Middleware data|Document login|SSR data|Data request|Required refresh|Obsolete chunk|Downstream SSR|Middleware and downstream|Refreshed|Follow-up|Invalid session|Auth cookie|Refresh cookie|Deletion cookie|Malformed final|Unexpected fixture)/.test(error.message);
  process.stderr.write(`${safe ? error.message : 'Local runtime qualification failed; inspect the harness without dumping secrets.'}\n`);
  process.exitCode = 1;
});
