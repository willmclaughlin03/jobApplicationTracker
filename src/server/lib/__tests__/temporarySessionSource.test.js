import {
  canonicalizeTemporarySessionAddress,
  parseTemporarySessionVercelAddress,
  resolveTemporarySessionSource,
  resolveTemporarySessionSourceMode,
  serializeTemporarySessionLegacySource,
} from '../temporarySessionSource.js';

/**
 * Creates a Vercel request with exact raw and normalized trusted headers.
 *
 * @param {string} value synthetic Vercel viewer-address value
 * @param {object} [overrides] request overrides
 * @returns {object} request fixture
 */
function createDeployedRequest(value, overrides = {}) {
  return {
    headers: { 'x-vercel-forwarded-for': value },
    rawHeaders: ['Host', 'example.test', 'X-Vercel-Forwarded-For', value],
    socket: { remoteAddress: '192.0.2.99' },
    ...overrides,
  };
}

describe('temporarySessionSource', () => {
  it('requires explicit Vercel mode and a consistent runtime marker', () => {
    expect(resolveTemporarySessionSourceMode({
      env: {
        NODE_ENV: 'production',
        VERCEL: '1',
        TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'vercel',
      },
    })).toBe('vercel');
    expect(resolveTemporarySessionSourceMode({
      env: { NODE_ENV: 'production', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'local' },
    })).toBeNull();
    expect(resolveTemporarySessionSourceMode({
      env: { NODE_ENV: 'production', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'vercel' },
    })).toBeNull();
    expect(resolveTemporarySessionSourceMode({
      env: { NODE_ENV: 'test', VERCEL: '1', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'local' },
    })).toBeNull();
    expect(resolveTemporarySessionSourceMode({
      env: { NODE_ENV: 'test', VERCEL: '1', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'vercel' },
    })).toBeNull();
    expect(resolveTemporarySessionSourceMode({ env: { NODE_ENV: 'production' } })).toBeNull();
  });

  it('uses only the local socket in local mode', () => {
    const source = resolveTemporarySessionSource({
      socket: { remoteAddress: '192.0.2.10' },
      headers: { 'x-forwarded-for': '198.51.100.8' },
    }, 'local');
    expect(source).toEqual({ family: 4, addressBytes: Buffer.from([192, 0, 2, 10]) });
    expect(resolveTemporarySessionSource({
      socket: {},
      headers: { 'x-forwarded-for': '198.51.100.8' },
    }, 'local')).toBeNull();
  });

  it('parses Vercel IPv4 and IPv6 scalars into canonical bytes', () => {
    expect(resolveTemporarySessionSource(
      createDeployedRequest('192.0.2.20'),
      'vercel'
    )).toEqual({ family: 4, addressBytes: Buffer.from([192, 0, 2, 20]) });
    expect(resolveTemporarySessionSource(
      createDeployedRequest('2001:db8::20'),
      'vercel'
    )).toEqual({
      family: 6,
      addressBytes: Buffer.from('20010db8000000000000000000000020', 'hex'),
    });
  });

  it('maps supported IPv4-mapped IPv6 to the IPv4 family', () => {
    expect(parseTemporarySessionVercelAddress('::ffff:192.0.2.30')).toEqual({
      family: 4,
      addressBytes: Buffer.from([192, 0, 2, 30]),
    });
    expect(canonicalizeTemporarySessionAddress('::ffff:c000:21e')).toEqual({
      family: 4,
      addressBytes: Buffer.from([192, 0, 2, 30]),
    });
  });

  it.each([
    ['missing raw metadata', { rawHeaders: [] }],
    ['odd raw metadata', { rawHeaders: ['Host'] }],
    ['non-string raw metadata', { rawHeaders: ['X-Vercel-Forwarded-For', 123] }],
    ['duplicate occurrence', {
      rawHeaders: [
        'X-Vercel-Forwarded-For', '192.0.2.40',
        'x-vercel-forwarded-for', '192.0.2.40',
      ],
    }],
    ['normalized array', { headers: { 'x-vercel-forwarded-for': ['192.0.2.40'] } }],
    ['normalized mismatch', { headers: { 'x-vercel-forwarded-for': '192.0.2.41' } }],
    ['comma joined', {
      headers: { 'x-vercel-forwarded-for': '192.0.2.40, 198.51.100.4' },
      rawHeaders: ['X-Vercel-Forwarded-For', '192.0.2.40, 198.51.100.4'],
    }],
  ])('rejects %s trusted-header input', (_label, overrides) => {
    expect(resolveTemporarySessionSource(
      createDeployedRequest('192.0.2.40', overrides),
      'vercel'
    )).toBeNull();
  });

  it.each([
    ' 192.0.2.50',
    '192.0.2.50 ',
    '192.0.2.50:443',
    '[2001:db8::50]',
    '2001:db8::50%zone',
    '192.0.2.999',
    'example.test',
    '192.0.2.50\t',
  ])('rejects malformed Vercel source syntax', (value) => {
    expect(parseTemporarySessionVercelAddress(value)).toBeNull();
  });

  it('does not fall back to forwarding headers or the deployed socket', () => {
    expect(resolveTemporarySessionSource({
      headers: {
        'x-forwarded-for': '192.0.2.60',
        forwarded: 'for=192.0.2.60',
        'x-real-ip': '192.0.2.60',
      },
      rawHeaders: [
        'X-Forwarded-For', '192.0.2.60',
        'Forwarded', 'for=192.0.2.60',
        'X-Real-IP', '192.0.2.60',
      ],
      socket: { remoteAddress: '192.0.2.61' },
    }, 'vercel')).toBeNull();
  });

  it('serializes equivalent addresses identically and separates families and values', () => {
    const nativeIpv4 = canonicalizeTemporarySessionAddress('192.0.2.30');
    const mappedIpv4 = canonicalizeTemporarySessionAddress('::ffff:192.0.2.30');
    const otherIpv4 = canonicalizeTemporarySessionAddress('192.0.2.31');
    const ipv6 = canonicalizeTemporarySessionAddress('2001:db8::1');

    expect(serializeTemporarySessionLegacySource(nativeIpv4)).toBe(
      serializeTemporarySessionLegacySource(mappedIpv4)
    );
    expect(new Set([
      serializeTemporarySessionLegacySource(nativeIpv4),
      serializeTemporarySessionLegacySource(otherIpv4),
      serializeTemporarySessionLegacySource(ipv6),
    ])).toHaveProperty('size', 3);
    expect(serializeTemporarySessionLegacySource(nativeIpv4)).toMatch(/^source:v1:f4:/);
    expect(serializeTemporarySessionLegacySource(ipv6)).toMatch(/^source:v1:f6:/);
  });

  it.each([
    null,
    {},
    { family: 4, addressBytes: Buffer.alloc(16) },
    { family: 6, addressBytes: Buffer.alloc(4) },
    { family: 7, addressBytes: Buffer.alloc(16) },
  ])('rejects invalid legacy serializer input', (source) => {
    expect(serializeTemporarySessionLegacySource(source)).toBeNull();
  });
});
