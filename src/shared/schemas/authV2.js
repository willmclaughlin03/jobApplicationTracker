/**
 * Strict production schemas for v2 authentication responses.
 *
 * Purpose: Validate exact public status, body, and header pairings without a
 * server-only or test-support dependency.
 * Connects to: shared auth constants and future isolated v2 auth routes.
 */

import { z } from 'zod';
import {
  AUTH_SESSION_ERROR_CODES,
  AUTH_SIGNOUT_ERROR_CODES,
  AUTH_SIGNOUT_REMOTE_TERMINATION,
  AUTH_SIGNOUT_STATUS,
  AUTH_STATUS,
  AUTH_USER_ROLES,
  AUTH_V2_VERSION,
  PRIVATE_NO_STORE,
} from '../constants/authV2.js';

export const safeUserSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
  role: z.enum([AUTH_USER_ROLES.USER, AUTH_USER_ROLES.ADMIN]),
}).strict();

const authenticatedSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.AUTHENTICATED),
  user: safeUserSchema,
}).strict();

const anonymousSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.ANONYMOUS),
  user: z.null(),
}).strict();

const serviceUnavailableSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.UNAVAILABLE),
  error: z.object({
    code: z.literal(AUTH_SESSION_ERROR_CODES.SESSION_UNAVAILABLE),
  }).strict(),
}).strict();

const rateLimitedSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.UNAVAILABLE),
  error: z.object({
    code: z.literal(AUTH_SESSION_ERROR_CODES.RATE_LIMITED),
  }).strict(),
}).strict();

const terminalSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.TERMINAL_UNAUTHENTICATED),
  error: z.object({
    code: z.literal(AUTH_SESSION_ERROR_CODES.ACCOUNT_ACCESS_RESTRICTED),
  }).strict(),
}).strict();

export const sessionResponseSchema = z.union([
  authenticatedSessionSchema,
  anonymousSessionSchema,
  serviceUnavailableSessionSchema,
  rateLimitedSessionSchema,
  terminalSessionSchema,
]);

const privateResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
}).strict();

const rateLimitedResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
  'retry-after': z.string().regex(/^\d+$/),
}).strict();

const sessionMethodResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
  allow: z.literal('GET'),
}).strict();

export const sessionHttpResponseSchema = z.union([
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: authenticatedSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: anonymousSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(503),
    headers: privateResponseHeadersSchema,
    body: serviceUnavailableSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(429),
    headers: rateLimitedResponseHeadersSchema,
    body: rateLimitedSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(403),
    headers: privateResponseHeadersSchema,
    body: terminalSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(405),
    headers: sessionMethodResponseHeadersSchema,
    body: serviceUnavailableSessionSchema,
  }).strict(),
]);

const completeSignoutSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_SIGNOUT_STATUS.COMPLETE),
  localCleanupIssued: z.literal(true),
  remoteTermination: z.enum([
    AUTH_SIGNOUT_REMOTE_TERMINATION.CONFIRMED,
    AUTH_SIGNOUT_REMOTE_TERMINATION.ALREADY_INVALID,
    AUTH_SIGNOUT_REMOTE_TERMINATION.NOT_NEEDED,
  ]),
}).strict();

const localOnlySignoutSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_SIGNOUT_STATUS.LOCAL_ONLY),
  localCleanupIssued: z.literal(true),
  remoteTermination: z.literal(AUTH_SIGNOUT_REMOTE_TERMINATION.UNCONFIRMED),
}).strict();

const rejectedSignoutSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_SIGNOUT_STATUS.REJECTED),
  error: z.object({
    code: z.literal(AUTH_SIGNOUT_ERROR_CODES.REQUEST_REJECTED),
  }).strict(),
}).strict();

export const signoutResponseSchema = z.union([
  completeSignoutSchema,
  localOnlySignoutSchema,
  rejectedSignoutSchema,
]);

const methodRejectedResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
  allow: z.literal('POST'),
}).strict();

export const signoutHttpResponseSchema = z.union([
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: completeSignoutSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: localOnlySignoutSchema,
  }).strict(),
  z.object({
    httpStatus: z.union([z.literal(400), z.literal(403)]),
    headers: privateResponseHeadersSchema,
    body: rejectedSignoutSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(405),
    headers: methodRejectedResponseHeadersSchema,
    body: rejectedSignoutSchema,
  }).strict(),
]);
