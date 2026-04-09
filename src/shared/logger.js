import pino from 'pino';
import crypto from 'crypto';

/**
 * Creates a structured logger instance
 *
 * Purpose: Centralized logging for consistent, structured error tracking
 * Connects to: All services and API handlers that need logging
 *
 * Configuration:
 * - Production: JSON format for log aggregation tools
 * - Development: Pretty-printed format with colors for readability
 */
export const REDACT_CONFIG = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'password',
    'access_token',
    'refresh_token',
    'err.config.headers.authorization',
    'err.config.headers.cookie',
  ],
  censor: '[REDACTED]',
};

function createLogger() {
  const isProduction = process.env.NODE_ENV === 'production';

  const options = {
    level: isProduction ? 'info' : 'debug',
    redact: REDACT_CONFIG,
    ...(isProduction
      ? {
          // Production: JSON format with optional Axiom transport
          formatters: {
            level: (label) => {
              return { level: label };
            },
          },
          ...(process.env.AXIOM_DATASET && process.env.AXIOM_TOKEN
            ? {
                transport: {
                  target: '@axiomhq/pino',
                  options: {
                    dataset: process.env.AXIOM_DATASET,
                    token: process.env.AXIOM_TOKEN,
                  },
                },
              }
            : {}),
        }
      : {
          // Development: Pretty format
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        }),
  };

  try {
    return pino(options);
  } catch (err) {
    process.stderr.write(`Logger init failed, falling back to stdout: ${err.message}\n`);
    const { transport, ...fallbackOptions } = options;
    return pino(fallbackOptions);
  }
}

/**
 * Singleton logger instance
 *
 * Usage:
 * - logger.info('User logged in', { userId: '123' })
 * - logger.error('Database error', { operation: 'getJobs', error: err.message })
 * - logger.warn('Rate limit approaching', { userId: '456', requests: 95 })
 * - logger.debug('Cache hit', { key: 'user:123' })
 */
export const logger = createLogger();

/**
 * Attaches a child logger with a unique requestId to req.log
 *
 * Purpose: Correlates all log entries from a single request lifecycle
 * Connects to: withRateLimit middleware (primary), any route that needs request tracing
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 */
export function attachRequestLogger(req) {
  const requestId = crypto.randomUUID();
  req.log = logger.child({ requestId });
  return requestId;
}
