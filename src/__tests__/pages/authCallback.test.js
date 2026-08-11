/**
 * CHUNK-0 cache regressions for the OAuth callback response boundary.
 *
 * Purpose: Prove every validation, success, provider-error, and exception
 * redirect becomes private before a cookie-capable callback path can return.
 * Connects to: src/pages/auth/callback.js and the CHUNK-6 cache fix.
 */

const mockExchangeCodeForSession = jest.fn();
const mockCreateApiRouteClient = jest.fn(() => ({
  auth: { exchangeCodeForSession: mockExchangeCodeForSession },
}));

jest.mock('../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: (...args) => mockCreateApiRouteClient(...args),
}));

jest.mock('../../server/lib/csrf.js', () => ({
  generateCsrfToken: jest.fn(() => null),
  setCsrfCookie: jest.fn(),
}));

jest.mock('../../shared/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../../client/components/Spinner', () => () => null);

const { getServerSideProps } = require('../../pages/auth/callback.js');

/**
 * Creates the callback response surface used by cache-header assertions.
 *
 * @returns {object} Minimal Next.js server response double.
 */
function createMockResponse() {
  return { setHeader: jest.fn() };
}

/**
 * Executes the callback with a selected query fixture.
 *
 * @param {object} query - Callback query values.
 * @returns {Promise<{result: object, res: object}>} Callback result and response.
 */
async function runCallback(query) {
  const res = createMockResponse();
  const result = await getServerSideProps({ req: { cookies: {} }, res, query });

  return { result, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExchangeCodeForSession.mockResolvedValue({
    data: { user: { id: '00000000-0000-4000-8000-000000000001' } },
    error: null,
  });
});

describe('OAuth callback private response contract', () => {
  it.each([
    ['missing code', {}],
    ['oversized code', { code: 'x'.repeat(2049) }],
  ])('sets private no-store before the %s validation redirect', async (_name, query) => {
    const { res } = await runCallback(query);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
  });

  it('sets private no-store on the successful exchange redirect', async () => {
    const { result, res } = await runCallback({ code: 'approved-code-fixture' });

    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    const cacheControlIndex = res.setHeader.mock.calls.findIndex(
      ([name]) => name === 'Cache-Control'
    );
    expect(res.setHeader.mock.invocationCallOrder[cacheControlIndex]).toBeLessThan(
      mockCreateApiRouteClient.mock.invocationCallOrder[0]
    );
  });

  it.each([
    ['returned provider error', () => mockExchangeCodeForSession.mockResolvedValue({ data: null, error: new Error('sanitized provider failure') })],
    ['thrown provider error', () => mockExchangeCodeForSession.mockRejectedValue(new Error('sanitized provider failure'))],
  ])('sets private no-store on a %s redirect', async (_name, configureExchange) => {
    configureExchange();
    const { result, res } = await runCallback({ code: 'approved-code-fixture' });

    expect(result).toEqual({
      redirect: { destination: '/login?error=sign_in_failed', permanent: false },
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});
