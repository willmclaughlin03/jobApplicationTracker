const { Readable } = require('stream');

const {
  MAX_WEBHOOK_RAW_BODY_BYTES,
  readRawBody,
} = require('../readRawBody.js');

function createRequest(chunks) {
  const req = Readable.from(chunks);
  req.headers = {};
  return req;
}

describe('readRawBody', () => {
  it('reads and caches the raw request body from a stream', async () => {
    const req = createRequest([Buffer.from('{"hello":"world"}')]);

    const rawBody = await readRawBody(req);

    expect(rawBody).toEqual(Buffer.from('{"hello":"world"}'));
    expect(req.rawBody).toEqual(Buffer.from('{"hello":"world"}'));
  });

  it('returns an existing raw body buffer without re-reading the stream', async () => {
    const req = createRequest([]);
    req.rawBody = Buffer.from('{"cached":true}');

    const rawBody = await readRawBody(req);

    expect(rawBody).toEqual(Buffer.from('{"cached":true}'));
  });

  it('normalizes an existing string raw body into a buffer', async () => {
    const req = createRequest([]);
    req.rawBody = '{"cached":"string"}';

    const rawBody = await readRawBody(req);

    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(rawBody.toString('utf8')).toBe('{"cached":"string"}');
  });

  it('rejects oversized payloads based on actual streamed bytes', async () => {
    const req = createRequest([Buffer.alloc(6, 'a')]);

    await expect(readRawBody(req, { maxBytes: 5 })).rejects.toMatchObject({
      code: 'RAW_BODY_TOO_LARGE',
      maxBytes: 5,
      statusCode: 413,
    });
  });

  it('accepts payloads equal to maxBytes', async () => {
    const maxBytes = 5;
    const expectedBody = Buffer.alloc(maxBytes, 'a');
    const req = createRequest([expectedBody]);

    const rawBody = await readRawBody(req, { maxBytes });

    expect(rawBody).toEqual(expectedBody);
    expect(req.rawBody).toEqual(expectedBody);
  });

  it('uses the documented default body cap when no override is provided', () => {
    expect(MAX_WEBHOOK_RAW_BODY_BYTES).toBe(256 * 1024);
  });
});
