import {
  AUTH_PROVIDER_OPERATIONS,
  createAuthProviderOperationTracker,
} from '../authProviderOperationTracker.js';

describe('createAuthProviderOperationTracker', () => {
  it.each([
    [
      'getUser',
      'https://project.supabase.co/auth/v1/user',
      { method: 'GET' },
      AUTH_PROVIDER_OPERATIONS.GET_USER,
    ],
    [
      'implicit refresh',
      'https://project.supabase.co/auth/v1/token?grant_type=refresh_token',
      { method: 'POST' },
      AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH,
    ],
  ])('tracks only the exact %s request', async (_name, input, init, expected) => {
    const fetchImplementation = jest.fn().mockResolvedValue({ ok: true });
    const tracker = createAuthProviderOperationTracker(fetchImplementation);

    await expect(tracker.fetch(input, init)).resolves.toEqual({ ok: true });

    expect(fetchImplementation).toHaveBeenCalledWith(input, init);
    expect(tracker.getOperation()).toBe(expected);
  });

  it.each([
    ['wrong user method', 'https://project.supabase.co/auth/v1/user', { method: 'POST' }],
    ['user query', 'https://project.supabase.co/auth/v1/user?source=test', { method: 'GET' }],
    ['user trailing slash', 'https://project.supabase.co/auth/v1/user/', { method: 'GET' }],
    ['wrong refresh grant', 'https://project.supabase.co/auth/v1/token?grant_type=password', { method: 'POST' }],
    ['extra refresh query', 'https://project.supabase.co/auth/v1/token?grant_type=refresh_token&extra=1', { method: 'POST' }],
    ['refresh fragment', 'https://project.supabase.co/auth/v1/token?grant_type=refresh_token#sentinel', { method: 'POST' }],
    ['non-auth path', 'https://project.supabase.co/rest/v1/user', { method: 'GET' }],
    ['embedded credentials', 'https://user:pass@project.supabase.co/auth/v1/user', { method: 'GET' }],
    ['unsupported protocol', 'data:text/plain,/auth/v1/user', { method: 'GET' }],
    ['malformed URL', 'not-an-absolute-url', { method: 'GET' }],
  ])('leaves %s untracked', async (_name, input, init) => {
    const tracker = createAuthProviderOperationTracker(jest.fn().mockResolvedValue({ ok: true }));

    await tracker.fetch(input, init);

    expect(tracker.getOperation()).toBeNull();
  });

  it('honors a Fetch init method override without retaining the Request object', async () => {
    const request = {
      url: 'https://project.supabase.co/auth/v1/user',
      method: 'POST',
      headers: { authorization: 'request-token-sentinel' },
    };
    const tracker = createAuthProviderOperationTracker(jest.fn().mockResolvedValue({ ok: true }));

    await tracker.fetch(request, { method: 'GET' });

    expect(tracker.getOperation()).toBe(AUTH_PROVIDER_OPERATIONS.GET_USER);
    expect(Object.keys(tracker)).toStrictEqual(['fetch', 'getOperation']);
    expect(JSON.stringify(tracker.getOperation())).not.toContain('request-token-sentinel');
  });

  it('updates bounded state before preserving a delegated fetch rejection', async () => {
    const failure = new Error('network-sentinel');
    const tracker = createAuthProviderOperationTracker(jest.fn().mockRejectedValue(failure));

    await expect(tracker.fetch(
      'https://project.supabase.co/auth/v1/token?grant_type=refresh_token',
      { method: 'POST', body: 'refresh-token-sentinel' }
    )).rejects.toBe(failure);

    expect(tracker.getOperation()).toBe(AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH);
    expect(JSON.stringify(tracker.getOperation())).not.toContain('refresh-token-sentinel');
  });

  it('resets stale operation state when the next fetch is unrecognized', async () => {
    const tracker = createAuthProviderOperationTracker(jest.fn().mockResolvedValue({ ok: true }));
    await tracker.fetch('https://project.supabase.co/auth/v1/user', { method: 'GET' });
    expect(tracker.getOperation()).toBe(AUTH_PROVIDER_OPERATIONS.GET_USER);

    await tracker.fetch('https://project.supabase.co/rest/v1/jobs', { method: 'GET' });
    expect(tracker.getOperation()).toBeNull();
  });

  it('keeps concurrent request trackers isolated', async () => {
    const first = createAuthProviderOperationTracker(jest.fn().mockResolvedValue({ ok: true }));
    const second = createAuthProviderOperationTracker(jest.fn().mockResolvedValue({ ok: true }));

    await Promise.all([
      first.fetch('https://project.supabase.co/auth/v1/user', { method: 'GET' }),
      second.fetch(
        'https://project.supabase.co/auth/v1/token?grant_type=refresh_token',
        { method: 'POST' }
      ),
    ]);

    expect(first.getOperation()).toBe(AUTH_PROVIDER_OPERATIONS.GET_USER);
    expect(second.getOperation()).toBe(AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH);
  });

  it('rejects a missing or non-function fetch implementation', () => {
    expect(() => createAuthProviderOperationTracker(null)).toThrow(TypeError);
  });
});
