import {
  canonicalizeTemporarySessionAddress,
  parseTemporarySessionViewerAddress,
  resolveTemporarySessionSource,
  resolveTemporarySessionSourceMode,
} from '../temporarySessionSource.js';

/**
 * Creates a deployed request with exact raw and normalized trusted headers.
 *
 * @param {string} value synthetic CloudFront viewer-address value
 * @param {object} [overrides] request overrides
 * @returns {object} request fixture
 */
function createDeployedRequest(value, overrides = {}) {
  return {
    headers: { 'cloudfront-viewer-address': value },
    rawHeaders: ['Host', 'example.test', 'CloudFront-Viewer-Address', value],
    socket: { remoteAddress: '192.0.2.99' },
    ...overrides,
  };
}

describe('temporarySessionSource', () => {
  it('requires deployed source mode in production', () => {
    expect(resolveTemporarySessionSourceMode({
      env: { NODE_ENV: 'production', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'deployed' },
    })).toBe('deployed');
    expect(resolveTemporarySessionSourceMode({
      env: { NODE_ENV: 'production', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'local' },
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

  it('parses deployed IPv4 and bracketed IPv6 into canonical bytes', () => {
    expect(resolveTemporarySessionSource(
      createDeployedRequest('192.0.2.20:443'),
      'deployed'
    )).toEqual({ family: 4, addressBytes: Buffer.from([192, 0, 2, 20]) });
    expect(resolveTemporarySessionSource(
      createDeployedRequest('[2001:db8::20]:8443'),
      'deployed'
    )).toEqual({
      family: 6,
      addressBytes: Buffer.from('20010db8000000000000000000000020', 'hex'),
    });
  });

  it('maps supported IPv4-mapped IPv6 to the IPv4 family', () => {
    expect(parseTemporarySessionViewerAddress('[::ffff:192.0.2.30]:443')).toEqual({
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
    ['duplicate occurrence', {
      rawHeaders: [
        'CloudFront-Viewer-Address', '192.0.2.40:443',
        'cloudfront-viewer-address', '192.0.2.40:443',
      ],
    }],
    ['normalized mismatch', { headers: { 'cloudfront-viewer-address': '192.0.2.41:443' } }],
    ['comma joined', {
      headers: { 'cloudfront-viewer-address': '192.0.2.40:443, 198.51.100.4:443' },
      rawHeaders: ['CloudFront-Viewer-Address', '192.0.2.40:443, 198.51.100.4:443'],
    }],
  ])('rejects %s trusted-header input', (_label, overrides) => {
    expect(resolveTemporarySessionSource(
      createDeployedRequest('192.0.2.40:443', overrides),
      'deployed'
    )).toBeNull();
  });

  it.each([
    '192.0.2.50',
    '192.0.2.50:0',
    '192.0.2.50:0443',
    '192.0.2.999:443',
    '2001:db8::50:443',
    '[2001:db8::50]:65536',
    '[2001:db8::50%zone]:443',
    'example.test:443',
  ])('rejects malformed deployed source syntax', (value) => {
    expect(parseTemporarySessionViewerAddress(value)).toBeNull();
  });

  it('does not fall back to forwarding headers or the deployed socket', () => {
    expect(resolveTemporarySessionSource({
      headers: { 'x-forwarded-for': '192.0.2.60' },
      rawHeaders: ['X-Forwarded-For', '192.0.2.60'],
      socket: { remoteAddress: '192.0.2.61' },
    }, 'deployed')).toBeNull();
  });
});
