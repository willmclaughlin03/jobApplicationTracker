const { ServerResponse } = require('node:http');
const path = require('node:path');
const inventory = require('../../testSupport/authRouteInventory.json');
const mockGetUserFromRequest = jest.fn();

jest.mock('../../server/lib/supabaseServer.js', () => ({
  getUserFromRequest: (...args) => mockGetUserFromRequest(...args),
}));
jest.mock('../../client/contexts/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('next/font/google', () => ({ Inter: () => ({ className: 'fixture-font', variable: 'fixture-font-variable' }) }));

describe('protected page request-time exports', () => {
  it.each(inventory.filter((entry) => entry.policy === 'protected-page'))(
    '$route exports request-time cache policy with empty props',
    async ({ file, route }) => {
      mockGetUserFromRequest.mockReset();
      mockGetUserFromRequest.mockResolvedValue({
        user: { id: 'fixture-admin', app_metadata: { role: 'admin' } },
      });
      const page = require(path.join(process.cwd(), 'src/pages', file));
      const res = new ServerResponse({ method: 'GET' });
      expect(typeof page.getServerSideProps).toBe('function');
      expect(page.getStaticProps).toBeUndefined();
      const result = await page.getServerSideProps({ req: { cookies: {} }, res });
      expect(result).toEqual({ props: {} });
      expect(res.getHeader('Cache-Control')).toBe('private, no-store');
      expect(res.getHeader('CDN-Cache-Control')).toBe('no-store');
      expect(res.getHeader('Vercel-CDN-Cache-Control')).toBe('no-store');
      expect(res.getHeader('Set-Cookie')).toBeUndefined();
      expect(mockGetUserFromRequest).toHaveBeenCalledTimes(route === '/admin/users' ? 1 : 0);
    }
  );
});
