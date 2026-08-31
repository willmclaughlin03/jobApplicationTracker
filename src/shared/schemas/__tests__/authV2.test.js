import {
  sessionHttpResponseSchema,
  sessionResponseSchema,
  signoutHttpResponseSchema,
  signoutResponseSchema,
} from '../authV2.js';
import {
  SESSION_RESPONSE_FIXTURES,
  SIGNOUT_RESPONSE_FIXTURES,
} from '../../../testSupport/authV2ContractFixtures.js';

describe('authV2 schemas', () => {
  it('accepts every frozen session body and exact HTTP pairing', () => {
    Object.values(SESSION_RESPONSE_FIXTURES).forEach((response) => {
      expect(sessionResponseSchema.safeParse(response.body).success).toBe(true);
      expect(sessionHttpResponseSchema.safeParse(response).success).toBe(true);
    });
  });

  it('rejects session overexposure, legacy envelopes, and status/header mismatches', () => {
    const authenticated = SESSION_RESPONSE_FIXTURES.authenticated;
    const invalidResponses = [
      { ...authenticated, httpStatus: 403 },
      {
        ...SESSION_RESPONSE_FIXTURES.rateLimited,
        headers: { 'cache-control': 'private, no-store' },
      },
      {
        ...SESSION_RESPONSE_FIXTURES.rejectedMethod,
        headers: { 'cache-control': 'private, no-store' },
      },
    ];
    const invalidBodies = [
      { data: SESSION_RESPONSE_FIXTURES.anonymous.body, error: null },
      { ...SESSION_RESPONSE_FIXTURES.anonymous.body, version: '2' },
      { ...SESSION_RESPONSE_FIXTURES.anonymous.body, extra: true },
      {
        ...authenticated.body,
        user: { ...authenticated.body.user, app_metadata: {} },
      },
    ];

    invalidResponses.forEach((response) => {
      expect(sessionHttpResponseSchema.safeParse(response).success).toBe(false);
    });
    invalidBodies.forEach((body) => {
      expect(sessionResponseSchema.safeParse(body).success).toBe(false);
    });
  });

  it('accepts every frozen sign-out body and exact HTTP pairing', () => {
    Object.values(SIGNOUT_RESPONSE_FIXTURES).forEach((response) => {
      expect(signoutResponseSchema.safeParse(response.body).success).toBe(true);
      expect(signoutHttpResponseSchema.safeParse(response).success).toBe(true);
    });
  });

  it('rejects sign-out ambiguity, legacy envelopes, and mismatched methods', () => {
    const invalidResponses = [
      { ...SIGNOUT_RESPONSE_FIXTURES.completeConfirmed, httpStatus: 403 },
      { ...SIGNOUT_RESPONSE_FIXTURES.rejectedForbidden, httpStatus: 200 },
      {
        ...SIGNOUT_RESPONSE_FIXTURES.rejectedMethod,
        headers: { 'cache-control': 'private, no-store' },
      },
    ];
    const invalidBodies = [
      { data: null, error: null },
      { ...SIGNOUT_RESPONSE_FIXTURES.localOnly.body, version: '2' },
      { ...SIGNOUT_RESPONSE_FIXTURES.localOnly.body, extra: true },
      {
        ...SIGNOUT_RESPONSE_FIXTURES.completeConfirmed.body,
        remoteTermination: 'global',
      },
    ];

    invalidResponses.forEach((response) => {
      expect(signoutHttpResponseSchema.safeParse(response).success).toBe(false);
    });
    invalidBodies.forEach((body) => {
      expect(signoutResponseSchema.safeParse(body).success).toBe(false);
    });
  });
});
