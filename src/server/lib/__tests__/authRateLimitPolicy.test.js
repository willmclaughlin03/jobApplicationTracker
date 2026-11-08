import { TIERS } from '../../../shared/constants/tiers.js';
import {
  AUTH_RATE_LIMIT_OPERATIONS, AUTH_RATE_LIMIT_TIERS, AUTH_RATE_LIMIT_POLICIES,
  getAuthRateLimitPolicy,
} from '../authRateLimitPolicy.js';

const expected = [
  ['AUTH_SESSION', 'user', 300, 2500],
  ['AUTH_LOGOUT', 'source', 30, 100],
  ['AUTH_FAILURE', 'source', 15, 30],
  ['AUTH_CALLBACK', 'source', 30, 100],
  ['PRE_AUTH', 'source', 3000, 30000],
];

/** Exercises every operation/tier against independent canonical policy values. */
describe('authRateLimitPolicy', () => {
  it('explicitly covers every currently reachable application tier', () => {
    expect(AUTH_RATE_LIMIT_TIERS).toEqual(Object.values(TIERS));
    expect(AUTH_RATE_LIMIT_OPERATIONS).toEqual(expected.map(([operation]) => operation));
  });
  it.each(AUTH_RATE_LIMIT_TIERS)('freezes all five bounded policies for %s', (tier) => {
    expect(Object.isFrozen(AUTH_RATE_LIMIT_POLICIES[tier])).toBe(true);
    for (const [operation, identity, hourly, daily] of expected) {
      const policy = getAuthRateLimitPolicy(operation, tier);
      expect(policy).toEqual({ identity, hourly, daily });
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });
  it.each([undefined, null, '', 'FREE', 'enterprise', '__proto__', {}, []])(
    'fails closed for invalid tier %p', (tier) => {
      expect(getAuthRateLimitPolicy('AUTH_SESSION', tier)).toBeNull();
    }
  );
  it.each([undefined, null, '', 'AUTH', 'AUTH_SIGNOUT', 'toString', {}, []])(
    'fails closed for invalid operation %p', (operation) => {
      expect(getAuthRateLimitPolicy(operation, 'free')).toBeNull();
    }
  );
});
