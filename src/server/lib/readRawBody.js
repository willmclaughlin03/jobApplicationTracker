export const MAX_WEBHOOK_RAW_BODY_BYTES = 256 * 1024;

function createRawBodyError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

/**
 * Read the raw request body for webhook signature verification.
 *
 * The byte cap is enforced while streaming so callers do not need to trust
 * `Content-Length`, which can be missing or misleading.
 *
 * @param {import('http').IncomingMessage & { rawBody?: Buffer | string }} req
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function readRawBody(req, options = {}) {
  const { maxBytes = MAX_WEBHOOK_RAW_BODY_BYTES } = options;

  if (!req || typeof req.on !== 'function') {
    throw createRawBodyError(
      'Raw body reader requires a request stream',
      'RAW_BODY_REQUEST_INVALID'
    );
  }

  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw createRawBodyError('Raw body size cap must be a positive integer', 'RAW_BODY_LIMIT_INVALID');
  }

  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  if (typeof req.rawBody === 'string') {
    const rawBodyBuffer = Buffer.from(req.rawBody);

    if (rawBodyBuffer.length > maxBytes) {
      throw createRawBodyError(
        `Webhook payload exceeded ${maxBytes} bytes`,
        'RAW_BODY_TOO_LARGE',
        {
          maxBytes,
          receivedBytes: rawBodyBuffer.length,
          statusCode: 413,
        }
      );
    }

    req.rawBody = rawBodyBuffer;
    return rawBodyBuffer;
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;

      if (totalBytes > maxBytes) {
        if (typeof req.resume === 'function') {
          req.resume();
        }

        rejectOnce(
          createRawBodyError(`Webhook payload exceeded ${maxBytes} bytes`, 'RAW_BODY_TOO_LARGE', {
            maxBytes,
            receivedBytes: totalBytes,
            statusCode: 413,
          })
        );
        return;
      }

      chunks.push(bufferChunk);
    };

    const onEnd = () => {
      const rawBodyBuffer = Buffer.concat(chunks, totalBytes);
      req.rawBody = rawBodyBuffer;
      resolveOnce(rawBodyBuffer);
    };

    const onError = (error) => {
      rejectOnce(error);
    };

    const onAborted = () => {
      rejectOnce(createRawBodyError('Request body stream was aborted', 'RAW_BODY_ABORTED'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}
