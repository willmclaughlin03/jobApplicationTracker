/**
 * Job Read Cursor - validated keyset helpers for ordered jobs reads.
 *
 * Purpose: Keep dashboard and CSV export pagination aligned on the same
 * created_at DESC, id DESC cursor contract without accepting client-built
 * PostgREST predicates.
 */

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts a validated keyset cursor from a database-owned job row.
 *
 * Purpose: full-list and export loops must fail closed if a query projection
 * omits either deterministic ordering field.
 *
 * @param {object|null|undefined} row - Last row returned by an ordered jobs query.
 * @returns {{ createdAt: string, id: string }|null} Valid cursor or null.
 */
export function getJobReadCursor(row) {
  const createdAt = row?.created_at;
  const id = row?.id;

  if (
    typeof createdAt !== 'string'
    || createdAt.length === 0
    || !Number.isFinite(Date.parse(createdAt))
    || typeof id !== 'string'
    || !JOB_ID_PATTERN.test(id)
  ) {
    return null;
  }

  return { createdAt, id };
}

/**
 * Builds the PostgREST predicate for rows older than a trusted cursor.
 *
 * Purpose: preserve deterministic descending pagination while keeping raw
 * filter construction isolated to values that originated from validated
 * database rows.
 *
 * @param {{ createdAt: string, id: string }} cursor - Validated database cursor.
 * @returns {string} PostgREST or predicate.
 * @throws {TypeError} When the cursor is malformed.
 */
export function buildJobReadCursorFilter(cursor) {
  const validatedCursor = getJobReadCursor({
    created_at: cursor?.createdAt,
    id: cursor?.id,
  });

  if (!validatedCursor) {
    throw new TypeError('Job read cursor is invalid');
  }

  return [
    'created_at.lt.' + validatedCursor.createdAt,
    'and(created_at.eq.' + validatedCursor.createdAt + ',id.lt.' + validatedCursor.id + ')',
  ].join(',');
}

/**
 * Verifies that a descending keyset cursor moved to an older row.
 *
 * Purpose: a repeated or out-of-order cursor could otherwise cause duplicate
 * rows or an infinite service-role query loop.
 *
 * @param {{ createdAt: string, id: string }|null} previousCursor - Prior page cursor.
 * @param {{ createdAt: string, id: string }|null} nextCursor - Candidate next cursor.
 * @returns {boolean} True when the candidate strictly advances.
 */
export function doesJobReadCursorAdvance(previousCursor, nextCursor) {
  if (!nextCursor) {
    return false;
  }

  if (!previousCursor) {
    return true;
  }

  if (nextCursor.createdAt < previousCursor.createdAt) {
    return true;
  }

  return nextCursor.createdAt === previousCursor.createdAt
    && nextCursor.id < previousCursor.id;
}
