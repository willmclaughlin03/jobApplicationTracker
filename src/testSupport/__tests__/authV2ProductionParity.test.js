import fs from 'node:fs';
import path from 'node:path';
import {
  APP_REQUEST_HEADER,
  APP_REQUEST_VALUE,
  AUTH_STATUS,
  AUTH_V2_VERSION,
  LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_VALUE,
  PRIVATE_NO_STORE,
} from '../../shared/constants/authV2.js';
import {
  sessionHttpResponseSchema as productionSessionHttpResponseSchema,
  sessionResponseSchema as productionSessionResponseSchema,
  signoutHttpResponseSchema as productionSignoutHttpResponseSchema,
  signoutResponseSchema as productionSignoutResponseSchema,
} from '../../shared/schemas/authV2.js';
import {
  APP_REQUEST_HEADER as FIXTURE_APP_REQUEST_HEADER,
  APP_REQUEST_VALUE as FIXTURE_APP_REQUEST_VALUE,
  AUTH_STATUS as FIXTURE_AUTH_STATUS,
  AUTH_V2_VERSION as FIXTURE_AUTH_V2_VERSION,
  LOGOUT_INTENT_HEADER as FIXTURE_LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_VALUE as FIXTURE_LOGOUT_INTENT_VALUE,
  PRIVATE_NO_STORE as FIXTURE_PRIVATE_NO_STORE,
  SESSION_RESPONSE_FIXTURES,
  SIGNOUT_RESPONSE_FIXTURES,
  sessionHttpResponseSchema as fixtureSessionHttpResponseSchema,
  sessionResponseSchema as fixtureSessionResponseSchema,
  signoutHttpResponseSchema as fixtureSignoutHttpResponseSchema,
  signoutResponseSchema as fixtureSignoutResponseSchema,
} from '../authV2ContractFixtures.js';

/**
 * Recursively lists JavaScript files beneath a production source directory.
 * Test directories are excluded so boundary checks inspect runtime modules only.
 *
 * @param {string} directory absolute directory to inspect
 * @returns {string[]} absolute JavaScript file paths
 */
function listProductionJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : listProductionJavaScriptFiles(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [absolutePath] : [];
  });
}

/**
 * Compares independent fixture and production schema decisions for one value.
 *
 * @param {object} fixtureSchema authoritative test-only schema
 * @param {object} productionSchema production-safe schema
 * @param {unknown} value contract candidate
 * @returns {void}
 */
function expectSchemaParity(fixtureSchema, productionSchema, value) {
  expect(productionSchema.safeParse(value).success)
    .toBe(fixtureSchema.safeParse(value).success);
}

describe('auth v2 production parity', () => {
  it('matches every production-safe frozen constant exactly', () => {
    expect(AUTH_V2_VERSION).toBe(FIXTURE_AUTH_V2_VERSION);
    expect(AUTH_STATUS).toStrictEqual(FIXTURE_AUTH_STATUS);
    expect(APP_REQUEST_HEADER).toBe(FIXTURE_APP_REQUEST_HEADER);
    expect(APP_REQUEST_VALUE).toBe(FIXTURE_APP_REQUEST_VALUE);
    expect(LOGOUT_INTENT_HEADER).toBe(FIXTURE_LOGOUT_INTENT_HEADER);
    expect(LOGOUT_INTENT_VALUE).toBe(FIXTURE_LOGOUT_INTENT_VALUE);
    expect(PRIVATE_NO_STORE).toBe(FIXTURE_PRIVATE_NO_STORE);
  });

  it('keeps independent session schemas in parity for fixtures and mutations', () => {
    const values = [
      ...Object.values(SESSION_RESPONSE_FIXTURES),
      ...Object.values(SESSION_RESPONSE_FIXTURES).map((response) => ({
        ...response,
        httpStatus: response.httpStatus === 200 ? 503 : 200,
      })),
      {
        ...SESSION_RESPONSE_FIXTURES.authenticated,
        body: { ...SESSION_RESPONSE_FIXTURES.authenticated.body, extra: true },
      },
      {
        ...SESSION_RESPONSE_FIXTURES.rateLimited,
        headers: { 'cache-control': PRIVATE_NO_STORE },
      },
    ];

    values.forEach((value) => {
      expectSchemaParity(
        fixtureSessionHttpResponseSchema,
        productionSessionHttpResponseSchema,
        value
      );
      expectSchemaParity(
        fixtureSessionResponseSchema,
        productionSessionResponseSchema,
        value.body
      );
    });
  });

  it('keeps independent sign-out schemas in parity for fixtures and mutations', () => {
    const values = [
      ...Object.values(SIGNOUT_RESPONSE_FIXTURES),
      ...Object.values(SIGNOUT_RESPONSE_FIXTURES).map((response) => ({
        ...response,
        httpStatus: response.httpStatus === 200 ? 403 : 200,
      })),
      {
        ...SIGNOUT_RESPONSE_FIXTURES.localOnly,
        body: { ...SIGNOUT_RESPONSE_FIXTURES.localOnly.body, extra: true },
      },
      {
        ...SIGNOUT_RESPONSE_FIXTURES.rejectedMethod,
        headers: { 'cache-control': PRIVATE_NO_STORE },
      },
    ];

    values.forEach((value) => {
      expectSchemaParity(
        fixtureSignoutHttpResponseSchema,
        productionSignoutHttpResponseSchema,
        value
      );
      expectSchemaParity(
        fixtureSignoutResponseSchema,
        productionSignoutResponseSchema,
        value.body
      );
    });
  });

  it('keeps runtime modules independent from test support', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const runtimeFiles = [
      ...listProductionJavaScriptFiles(path.join(sourceRoot, 'shared')),
      ...listProductionJavaScriptFiles(path.join(sourceRoot, 'server')),
    ];

    runtimeFiles.forEach((file) => {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/(?:from\s+|require\s*\()[^\n]*testSupport/);
    });
  });

  it('keeps shared auth modules browser-safe and fixture schemas independent', () => {
    const sharedAuthSources = [
      path.join(process.cwd(), 'src/shared/constants/authV2.js'),
      path.join(process.cwd(), 'src/shared/schemas/authV2.js'),
    ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const fixtureSource = fs.readFileSync(
      path.join(process.cwd(), 'src/testSupport/authV2ContractFixtures.js'),
      'utf8'
    );

    expect(sharedAuthSources).not.toMatch(/@supabase|node:|src\/server|\.\.\/\.\.\/server|process\.env/);
    expect(fixtureSource).not.toMatch(/shared\/(?:constants|schemas)\/authV2/);
  });
});
