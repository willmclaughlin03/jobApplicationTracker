/**
 * Response formatting utilities for consistent API responses
 *
 * Purpose: Standardize all API responses to { data, error, message } shape
 * Connects to: All API route handlers in src/pages/api/
 *
 * Benefits:
 * - Client-side code can reliably check response.error for failures
 * - Consistent error handling across all endpoints
 * - Easier to debug with predictable response structure
 */

/**
 * Creates a standardized success response
 *
 * @param {*} data - The payload to return to the client
 * @param {string} message - Optional success message
 * @param {Object|null} metadata - Optional top-level response metadata
 * @returns {Object} { data, error: null, message, ...metadata }
 */
export function createSuccessResponse(data, message = 'Success', metadata = null) {
  const response = {
    data,
    error: null,
    message,
  };

  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const [key, value] of Object.entries(metadata)) {
      if (!['data', 'error', 'message'].includes(key)) {
        response[key] = value;
      }
    }
  }

  return response;
}

/**
 * Creates a standardized error response
 *
 * @param {string} errorCode - Error code from ERROR_MESSAGES (e.g., 'FETCH_FAILED')
 * @param {string} message - User-facing error message
 * @returns {Object} { data: null, error: errorCode, message }
 */
export function createErrorResponse(errorCode, message) {
  return {
    data: null,
    error: errorCode,
    message,
  };
}

/**
 * Sends a success response with standardized format
 *
 * @param {Object} res - Next.js response object
 * @param {number} statusCode - HTTP status code (e.g., 200, 201)
 * @param {*} data - The payload to return
 * @param {string} message - Success message
 * @param {Object|null} metadata - Optional top-level response metadata
 */
export function sendSuccess(res, statusCode, data, message, metadata = null) {
  return res.status(statusCode).json(createSuccessResponse(data, message, metadata));
}

/**
 * Sends an error response with standardized format
 *
 * @param {Object} res - Next.js response object
 * @param {number} statusCode - HTTP status code (e.g., 400, 404, 500)
 * @param {string} errorCode - Error code from ERROR_MESSAGES
 * @param {string} message - User-facing error message
 */
export function sendError(res, statusCode, errorCode, message) {
  return res.status(statusCode).json(createErrorResponse(errorCode, message));
}
