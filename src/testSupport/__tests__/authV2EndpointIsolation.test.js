/**
 * CHUNK-0 endpoint-isolation sentinels for the future v2 auth routes.
 *
 * Purpose: Keep v2 route creation as an explicit expected-red boundary without
 * importing a missing module or attaching v2 behavior to a legacy v1 handler.
 * Connects to: CHUNK-2 session and CHUNK-4 sign-out production work.
 */

const fs = require('node:fs');
const path = require('node:path');

const futureRoutes = [
  {
    owner: 'CHUNK-2',
    route: '/api/auth/v2/session',
    source: 'src/pages/api/auth/v2/session.js',
  },
  {
    owner: 'CHUNK-4',
    route: '/api/auth/v2/signout',
    source: 'src/pages/api/auth/v2/signout.js',
  },
];

describe('v1/v2 auth endpoint isolation', () => {
  it.each(futureRoutes)(
    '$owner creates $route at its isolated source path',
    ({ source }) => {
      expect(fs.existsSync(path.join(process.cwd(), source))).toBe(true);
    }
  );

  it('keeps both legacy v1 handlers present during the pre-production overlap', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'src/pages/api/auth/session.js'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'src/pages/api/auth/signout.js'))).toBe(true);
  });

  it.each([
    'src/pages/api/auth/session.js',
    'src/pages/api/auth/signout.js',
  ])('keeps legacy handler %s free of a v2 fallback import', (source) => {
    const contents = fs.readFileSync(path.join(process.cwd(), source), 'utf8');

    expect(contents).not.toMatch(/(?:import|require)\s*\(?[^\n]*auth\/v2/);
  });

  it.each(futureRoutes)(
    '$owner keeps $route behavior independent from the legacy handler',
    ({ source }) => {
      expect.assertions(1);

      const absoluteSource = path.join(process.cwd(), source);

      if (!fs.existsSync(absoluteSource)) return;

      const contents = fs.readFileSync(absoluteSource, 'utf8');
      expect(contents).not.toMatch(/api\/auth\/(?:session|signout)\.js/);
    }
  );
});
