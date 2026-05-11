const {
  BILLING_PAGE_ACTIONS,
  resolveBillingRedirectResult,
  runBillingPageRedirectAction,
} = require('../billingPageActions.js');

describe('billingPageActions', () => {
  it('normalizes redirect responses into a redirect URL or a concrete error message', () => {
    expect(
      resolveBillingRedirectResult({
        result: { data: { data: { url: 'https://billing.example.test' } }, error: null },
        requestFailureMessage: 'request failed',
        fallbackApiFailureMessage: 'api failed',
        missingUrlMessage: 'missing url',
      })
    ).toEqual({
      redirectUrl: 'https://billing.example.test',
      errorMessage: null,
    });

    expect(
      resolveBillingRedirectResult({
        result: { data: { error: 'CHECKOUT_SESSION_FAILED', message: 'Stripe said no' }, error: null },
        requestFailureMessage: 'request failed',
        fallbackApiFailureMessage: 'api failed',
        missingUrlMessage: 'missing url',
      })
    ).toEqual({
      redirectUrl: null,
      errorMessage: 'Stripe said no',
    });
  });

  it('keeps checkout loading active while redirect handoff is attempted successfully', async () => {
    const setActionLoading = jest.fn();
    const setErrorMessage = jest.fn();
    const navigate = jest.fn();

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => ({ data: { data: { url: 'https://checkout.example.test' } }, error: null }),
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: 'Checkout request failed',
      fallbackApiFailureMessage: 'Checkout API failed',
      missingUrlMessage: 'Checkout missing URL',
      navigationFailedMessage: 'Checkout navigation failed',
      navigate,
    });

    expect(setActionLoading).toHaveBeenNthCalledWith(1, BILLING_PAGE_ACTIONS.CHECKOUT);
    expect(setActionLoading).not.toHaveBeenCalledWith('');
    expect(setErrorMessage).toHaveBeenCalledWith('');
    expect(navigate).toHaveBeenCalledWith('https://checkout.example.test');
  });

  it('keeps portal loading active while redirect handoff is attempted successfully', async () => {
    const setActionLoading = jest.fn();
    const setErrorMessage = jest.fn();
    const navigate = jest.fn();

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.PORTAL,
      request: async () => ({ data: { data: { url: 'https://portal.example.test' } }, error: null }),
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: 'Portal request failed',
      fallbackApiFailureMessage: 'Portal API failed',
      missingUrlMessage: 'Portal missing URL',
      navigationFailedMessage: 'Portal navigation failed',
      navigate,
    });

    expect(setActionLoading).toHaveBeenNthCalledWith(1, BILLING_PAGE_ACTIONS.PORTAL);
    expect(setActionLoading).not.toHaveBeenCalledWith('');
    expect(setErrorMessage).toHaveBeenCalledWith('');
    expect(navigate).toHaveBeenCalledWith('https://portal.example.test');
  });

  it('clears loading for request failures, API failures, and missing redirect URLs', async () => {
    const setActionLoading = jest.fn();
    const setErrorMessage = jest.fn();

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => {
        throw new Error('network');
      },
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: 'Checkout request failed',
      fallbackApiFailureMessage: 'Checkout API failed',
      missingUrlMessage: 'Checkout missing URL',
      navigationFailedMessage: 'Checkout navigation failed',
    });

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => ({ data: { error: 'CHECKOUT_SESSION_FAILED', message: 'Checkout API rejected the request' }, error: null }),
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: 'Checkout request failed',
      fallbackApiFailureMessage: 'Checkout API failed',
      missingUrlMessage: 'Checkout missing URL',
      navigationFailedMessage: 'Checkout navigation failed',
    });

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => ({ data: { data: {} }, error: null }),
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: 'Checkout request failed',
      fallbackApiFailureMessage: 'Checkout API failed',
      missingUrlMessage: 'Checkout missing URL',
      navigationFailedMessage: 'Checkout navigation failed',
    });

    expect(setActionLoading).toHaveBeenCalledWith('');
    expect(setErrorMessage).toHaveBeenCalledWith('Checkout request failed');
    expect(setErrorMessage).toHaveBeenCalledWith('Checkout API rejected the request');
    expect(setErrorMessage).toHaveBeenCalledWith('Checkout missing URL');
  });

  it('clears loading when portal navigation throws after a redirect URL is returned', async () => {
    const setActionLoading = jest.fn();
    const setErrorMessage = jest.fn();

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.PORTAL,
      request: async () => ({ data: { data: { url: 'https://portal.example.test' } }, error: null }),
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: 'Portal request failed',
      fallbackApiFailureMessage: 'Portal API failed',
      missingUrlMessage: 'Portal missing URL',
      navigationFailedMessage: 'Portal navigation failed',
      navigate: () => {
        throw new Error('navigation failed');
      },
    });

    expect(setActionLoading).toHaveBeenCalledWith('');
    expect(setErrorMessage).toHaveBeenCalledWith('Portal navigation failed');
  });
});
