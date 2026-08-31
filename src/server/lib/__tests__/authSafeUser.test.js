import { normalizeAuthSafeUser } from '../authSafeUser.js';
import {
  ROLE_NORMALIZATION_FIXTURES,
  SAFE_USER_FIXTURE,
} from '../../../testSupport/authV2ContractFixtures.js';

/**
 * Builds a provider user with explicit application metadata for normalization.
 *
 * @param {unknown} rawRole raw provider role
 * @returns {object} provider user candidate
 */
function createProviderUser(rawRole) {
  return {
    id: SAFE_USER_FIXTURE.id,
    email: 'person@example.com',
    app_metadata: { role: rawRole },
    identities: [{ identity_data: { token: 'identity-token-sentinel' } }],
    user_metadata: { picture: 'provider-picture-sentinel' },
  };
}

describe('normalizeAuthSafeUser', () => {
  it.each(ROLE_NORMALIZATION_FIXTURES)(
    'normalizes exact role value $raw to $result',
    ({ raw, result }) => {
      const normalized = normalizeAuthSafeUser(createProviderUser(raw));

      if (result === 'unavailable') {
        expect(normalized).toStrictEqual({ ok: false });
        return;
      }
      expect(normalized).toStrictEqual({
        ok: true,
        user: {
          id: SAFE_USER_FIXTURE.id,
          email: 'person@example.com',
          role: result,
        },
      });
    }
  );

  it('defaults absent metadata and email to least-privileged safe values', () => {
    expect(normalizeAuthSafeUser({ id: SAFE_USER_FIXTURE.id })).toStrictEqual({
      ok: true,
      user: {
        id: SAFE_USER_FIXTURE.id,
        email: null,
        role: 'user',
      },
    });
    expect(normalizeAuthSafeUser({
      id: SAFE_USER_FIXTURE.id,
      email: null,
      app_metadata: null,
    })).toStrictEqual({
      ok: true,
      user: {
        id: SAFE_USER_FIXTURE.id,
        email: null,
        role: 'user',
      },
    });
  });

  it.each([
    ['null user', null],
    ['array user', []],
    ['invalid UUID', createProviderUser('user')],
    ['invalid email', { ...createProviderUser('user'), email: 'not-an-email' }],
    ['malformed metadata', { ...createProviderUser('user'), app_metadata: 'user' }],
  ])('fails closed for a %s', (_name, candidate) => {
    const value = _name === 'invalid UUID' ? { ...candidate, id: 'not-a-uuid' } : candidate;
    expect(normalizeAuthSafeUser(value)).toStrictEqual({ ok: false });
  });

  it('constructs a new three-field object that strips every provider field', () => {
    const providerUser = createProviderUser('admin');
    const normalized = normalizeAuthSafeUser(providerUser);

    expect(normalized.ok).toBe(true);
    expect(normalized.user).not.toBe(providerUser);
    expect(Object.keys(normalized.user)).toStrictEqual(['id', 'email', 'role']);
    expect(JSON.stringify(normalized)).not.toContain('identity-token-sentinel');
    expect(JSON.stringify(normalized)).not.toContain('provider-picture-sentinel');
  });

  it('remains fail closed when provider getters throw', () => {
    const providerUser = {};
    Object.defineProperty(providerUser, 'app_metadata', {
      get() {
        throw new Error('provider-getter-sentinel');
      },
    });

    expect(normalizeAuthSafeUser(providerUser)).toStrictEqual({ ok: false });
  });
});
