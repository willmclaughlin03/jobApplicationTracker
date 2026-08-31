import {
  AUTH_REQUEST_POLICY_REASONS,
  evaluateAppRequestPolicy,
  evaluateLogoutIntentPolicy,
} from '../authRequestPolicy.js';
import {
  APP_REQUEST_DECISION_FIXTURES,
  APP_REQUEST_HEADER,
} from '../../../testSupport/authV2ContractFixtures.js';

/**
 * Builds consistent normalized and raw header views for one intent header.
 *
 * @param {string} name contract header name
 * @param {unknown} normalizedValue normalized Node header value
 * @param {unknown} rawValue raw Node header value
 * @returns {object} request double
 */
function createIntentRequest(name, normalizedValue = '1', rawValue = '1') {
  return {
    headers: { [name.toLowerCase()]: normalizedValue },
    rawHeaders: [name, rawValue],
  };
}

describe('auth request intent policies', () => {
  /**
   * Verifies the documented Node-style header views are accepted together.
   */
  it('accepts the documented Node-style request contract', () => {
    const headers = Object.create(null);
    headers['x-app-request'] = '1';
    const request = {
      headers,
      rawHeaders: ['Host', 'example.test', 'X-App-Request', '1'],
    };

    expect(evaluateAppRequestPolicy(request)).toStrictEqual({
      accepted: true,
      reason: AUTH_REQUEST_POLICY_REASONS.ACCEPTED,
    });
  });

  /**
   * Verifies Web Headers fail closed until adapted to the Node-style contract.
   */
  it('rejects Web Headers objects outside the Node-style request contract', () => {
    const request = {
      headers: new Headers({ 'X-App-Request': '1' }),
      rawHeaders: ['X-App-Request', '1'],
    };

    expect(evaluateAppRequestPolicy(request)).toStrictEqual({
      accepted: false,
      reason: AUTH_REQUEST_POLICY_REASONS.MALFORMED,
    });
  });

  it.each([
    ['application request', evaluateAppRequestPolicy, 'X-App-Request'],
    ['logout intent', evaluateLogoutIntentPolicy, 'X-Logout-Intent'],
  ])('accepts one exact %s in both header representations', (_name, evaluate, headerName) => {
    expect(evaluate(createIntentRequest(headerName))).toStrictEqual({
      accepted: true,
      reason: AUTH_REQUEST_POLICY_REASONS.ACCEPTED,
    });
  });

  /**
   * Keeps the implementation's acceptance decisions aligned with the shared contract fixtures.
   */
  it.each(APP_REQUEST_DECISION_FIXTURES)(
    'matches the shared $name application-request decision',
    ({ value, accepted }) => {
      const request = value === undefined
        ? { headers: {}, rawHeaders: [] }
        : createIntentRequest(
          APP_REQUEST_HEADER,
          value,
          Array.isArray(value) ? value[0] : value
        );

      expect(evaluateAppRequestPolicy(request).accepted).toBe(accepted);
    }
  );

  it.each([
    ['missing', { headers: {}, rawHeaders: [] }, AUTH_REQUEST_POLICY_REASONS.MISSING],
    ['blank', createIntentRequest('X-App-Request', '', ''), AUTH_REQUEST_POLICY_REASONS.INVALID_VALUE],
    ['whitespace', createIntentRequest('X-App-Request', ' 1 ', ' 1 '), AUTH_REQUEST_POLICY_REASONS.INVALID_VALUE],
    ['wrong', createIntentRequest('X-App-Request', '2', '2'), AUTH_REQUEST_POLICY_REASONS.INVALID_VALUE],
    ['comma joined', createIntentRequest('X-App-Request', '1, 1', '1, 1'), AUTH_REQUEST_POLICY_REASONS.INVALID_VALUE],
    ['array value', createIntentRequest('X-App-Request', ['1', '1'], '1'), AUTH_REQUEST_POLICY_REASONS.ARRAY_VALUE],
    ['raw duplicate', {
      headers: { 'x-app-request': '1, 1' },
      rawHeaders: ['X-App-Request', '1', 'x-app-request', '1'],
    }, AUTH_REQUEST_POLICY_REASONS.DUPLICATE],
    ['normalized casing duplicate', {
      headers: { 'x-app-request': '1', 'X-App-Request': '1' },
      rawHeaders: ['X-App-Request', '1'],
    }, AUTH_REQUEST_POLICY_REASONS.DUPLICATE],
    ['normalized only', {
      headers: { 'x-app-request': '1' },
      rawHeaders: [],
    }, AUTH_REQUEST_POLICY_REASONS.REPRESENTATION_MISMATCH],
    ['raw only', {
      headers: {},
      rawHeaders: ['X-App-Request', '1'],
    }, AUTH_REQUEST_POLICY_REASONS.REPRESENTATION_MISMATCH],
    ['different representations', createIntentRequest('X-App-Request', '1', '2'), AUTH_REQUEST_POLICY_REASONS.REPRESENTATION_MISMATCH],
    ['odd raw list', {
      headers: { 'x-app-request': '1' },
      rawHeaders: ['X-App-Request'],
    }, AUTH_REQUEST_POLICY_REASONS.MALFORMED],
    ['non-string raw pair', {
      headers: { 'x-app-request': '1' },
      rawHeaders: ['Other', 1, 'X-App-Request', '1'],
    }, AUTH_REQUEST_POLICY_REASONS.MALFORMED],
  ])('rejects an ambiguous %s app-request header', (_name, request, reason) => {
    expect(evaluateAppRequestPolicy(request)).toStrictEqual({ accepted: false, reason });
  });

  it('rejects differently cased duplicate logout headers before later policy work', () => {
    const request = {
      headers: { 'x-logout-intent': '1, 1' },
      rawHeaders: ['X-Logout-Intent', '1', 'x-logout-intent', '1'],
    };

    expect(evaluateLogoutIntentPolicy(request)).toStrictEqual({
      accepted: false,
      reason: AUTH_REQUEST_POLICY_REASONS.DUPLICATE,
    });
  });

  it('does not inspect bodies, cookies, or downstream dependencies on rejection', () => {
    const bodyGetter = jest.fn(() => {
      throw new Error('body-side-effect-sentinel');
    });
    const cookieGetter = jest.fn(() => {
      throw new Error('cookie-side-effect-sentinel');
    });
    const request = { headers: {}, rawHeaders: [] };
    const sideEffects = {
      provider: jest.fn(),
      redis: jest.fn(),
      authCookieMutation: jest.fn(),
      csrfMutation: jest.fn(),
      bodyProcessing: jest.fn(),
    };
    Object.defineProperty(request, 'body', { get: bodyGetter });
    Object.defineProperty(request, 'cookies', { get: cookieGetter });

    const decision = evaluateAppRequestPolicy(request);
    if (decision.accepted) Object.values(sideEffects).forEach((effect) => effect());

    expect(decision.accepted).toBe(false);
    expect(bodyGetter).not.toHaveBeenCalled();
    expect(cookieGetter).not.toHaveBeenCalled();
    Object.values(sideEffects).forEach((effect) => expect(effect).not.toHaveBeenCalled());
  });

  it('returns bounded reasons without echoing hostile header values', () => {
    const sentinel = 'raw-intent-token-sentinel';
    const decision = evaluateAppRequestPolicy(
      createIntentRequest('X-App-Request', sentinel, sentinel)
    );

    expect(decision).toStrictEqual({
      accepted: false,
      reason: AUTH_REQUEST_POLICY_REASONS.INVALID_VALUE,
    });
    expect(JSON.stringify(decision)).not.toContain(sentinel);
  });

  it('fails closed when request header accessors throw', () => {
    const request = { rawHeaders: [] };
    Object.defineProperty(request, 'headers', {
      get() {
        throw new Error('header-getter-sentinel');
      },
    });

    expect(evaluateLogoutIntentPolicy(request)).toStrictEqual({
      accepted: false,
      reason: AUTH_REQUEST_POLICY_REASONS.MALFORMED,
    });
  });
});
