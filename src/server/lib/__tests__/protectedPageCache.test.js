const { ServerResponse } = require('node:http');
const { applyProtectedPageCache } = require('../protectedPageCache.js');

describe('protected page cache policy', () => {
  it('sets all cache boundaries without changing response state or cookies', () => {
    const res = new ServerResponse({ method: 'GET' });
    const cookies = ['synthetic-session=fixture; HttpOnly', 'synthetic-old=; Max-Age=0'];
    res.statusCode = 403;
    res.setHeader('Set-Cookie', cookies);
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    res.setHeader('CDN-Cache-Control', 'max-age=60');
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=60');
    applyProtectedPageCache(res);
    applyProtectedPageCache(res);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res.getHeader('CDN-Cache-Control')).toBe('no-store');
    expect(res.getHeader('Vercel-CDN-Cache-Control')).toBe('no-store');
    expect(res.getHeader('Set-Cookie')).toBe(cookies);
    expect(res.getHeader('Content-Security-Policy')).toBe("default-src 'self'");
    expect(res.getHeader('Vary')).toBe('Accept-Encoding');
    expect(res.statusCode).toBe(403);
    expect(res.writableEnded).toBe(false);
  });
});
