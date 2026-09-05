const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
const { spawn } = require('node:child_process');
const {
  COOKIE_NAME, fixtureEnvironment, applyResponseCookies, assertPrivateResponse,
  startFixtureProvider, spawnNext,
} = require('../protectedPageRuntimeHarness.js');

describe('local runtime qualification boundaries', () => {
  /** Construct an owned subprocess double; no OS process is created by these tests. */
  function childFixture() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = jest.fn(() => {
      child.exitCode = 0;
      child.emit('exit', 0);
    });
    spawn.mockReturnValue(child);
    return child;
  }

  it('bounds waits and stops only its owned hidden Next subprocess', async () => {
    const child = childFixture();
    const owned = spawnNext(process.cwd(), ['start'], {});
    expect(spawn.mock.calls.at(-1)[2]).toEqual(expect.objectContaining({ windowsHide: true }));
    expect(await owned.wait(1)).toBe(-2);
    await owned.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it('retains error flags, not raw subprocess output or spawn errors', async () => {
    const child = childFixture();
    const owned = spawnNext(process.cwd(), ['build'], {});
    child.stderr.write('ERR_REQUIRE_');
    child.stderr.write('ESM synthetic-sensitive-output');
    expect(owned.flags).toEqual({ moduleFailure: true });
    expect(JSON.stringify(owned)).not.toContain('synthetic-sensitive-output');
    child.emit('error', new Error('synthetic-sensitive-error'));
    expect(await owned.wait(100)).toBe(-1);
    await owned.stop();
  });

  it('copies OS plumbing but excludes inherited real credentials and telemetry', () => {
    const env = fixtureEnvironment({ Path: 'fixture-path', TEMP: 'fixture-temp',
      SUPABASE_SERVICE_ROLE_KEY: 'must-not-inherit', AXIOM_TOKEN: 'must-not-inherit',
      TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON: 'must-not-inherit',
    }, 'http://127.0.0.1:1234');
    expect(env.Path).toBe('fixture-path');
    expect(env.TEMP).toBe('fixture-temp');
    expect(env.SUPABASE_SERVICE_ROLE_KEY).not.toBe('must-not-inherit');
    expect(env.AXIOM_TOKEN).toBeUndefined();
    expect(env.TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON).toBeUndefined();
    expect(() => fixtureEnvironment({}, 'https://example.com')).toThrow('loopback');
  });

  it('applies serialized writes/deletions only to the intended jar and returns counts', () => {
    const a = new Map([[`${COOKIE_NAME}.0`, 'old-fixture']]);
    const b = new Map([[COOKIE_NAME, 'other-fixture']]);
    const counts = applyResponseCookies(a, [
      `${COOKIE_NAME}.0=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`,
      `${COOKIE_NAME}=new-fixture; Max-Age=3600; HttpOnly; Secure; SameSite=Lax; Path=/`,
    ]);
    expect(counts).toEqual({ writes: 2, deletions: 1 });
    expect(a.has(`${COOKIE_NAME}.0`)).toBe(false);
    expect(a.get(COOKIE_NAME)).toBe('new-fixture');
    expect(b.get(COOKIE_NAME)).toBe('other-fixture');
  });

  it.each(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])('rejects a missing auth cookie attribute: %s', (attribute) => {
    const cookie = `${COOKIE_NAME}=fixture; Max-Age=60; HttpOnly; Secure; SameSite=Lax; Path=/`;
    expect(() => applyResponseCookies(new Map(), [cookie.replace(`; ${attribute}`, '')])).toThrow('attributes');
  });

  it('rejects nonempty deletion cookies and public cache policy without leaking values', () => {
    expect(() => applyResponseCookies(new Map(), [
      `${COOKIE_NAME}=sensitive-fixture; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`,
    ])).toThrow('Deletion cookie must have empty value.');
    expect(() => assertPrivateResponse({ headers: new Headers({ 'Cache-Control': 'public' }) })).toThrow('private no-store');
  });

  it('supports single-use refresh and keeps observations free of credential data', async () => {
    const provider = await startFixtureProvider();
    try {
      const { session, jar } = provider.issueSession('admin', { expired: true, chunked: true });
      expect(provider.identify(jar)).toBe('admin');
      const response = await fetch(`${provider.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      expect(response.status).toBe(200);
      const renewed = await response.json();
      const user = await fetch(`${provider.url}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${renewed.access_token}` },
      });
      expect(user.status).toBe(200);
      await user.arrayBuffer();
      const repeated = await fetch(`${provider.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      expect(repeated.status).toBe(400);
      await repeated.arrayBuffer();
      expect(JSON.stringify(provider.observations)).not.toContain(session.access_token);
      expect(JSON.stringify(provider.observations)).not.toContain(session.refresh_token);
      expect(provider.observations.map((entry) => entry.operation)).toEqual(['refresh', 'user', 'refresh']);
    } finally { await provider.close(); }
  });
});
