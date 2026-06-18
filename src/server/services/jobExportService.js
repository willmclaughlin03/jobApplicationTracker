/**
 * Job Export Service - CSV export for owned job rows.
 *
 * Purpose: Provide the explicit Chunk 8 data-portability path without changing
 * ordinary locked-row API projections. The export intentionally uses a small
 * user-facing column allowlist and owner-scoped service-role reads.
 *
 * Connects to:
 * - supabaseAdmin for the server-owned jobs table boundary
 * - /api/storage/export for authenticated CSV downloads
 */
import { supabaseAdmin } from '../lib/supabaseServer.js';
import { logger as defaultLogger } from '../../shared/logger.js';

export const JOB_EXPORT_COLUMNS = Object.freeze([
  'company',
  'position',
  'status',
  'notes',
  'created_at',
]);

const JOB_EXPORT_SELECT = JOB_EXPORT_COLUMNS.join(',');
const JOB_EXPORT_PAGE_SIZE = 1000;
const FORMULA_LIKE_CELL_PATTERN = /^\s*[=+\-@]/;
const CONTROL_FORMULA_CELL_PATTERN = /^[\t\r]/;

/**
 * Converts a database value into exportable cell text.
 *
 * Purpose: CSV exports need stable empty-cell behavior for null/undefined
 * values while preserving ordinary string, number, and timestamp values.
 *
 * @param {unknown} value - Raw database value for one export column.
 * @returns {string} String cell value, or an empty string for absent values.
 */
function normalizeCsvCellValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

/**
 * Neutralizes values spreadsheet apps could interpret as formulas.
 *
 * Purpose: CSV is often opened in spreadsheets; prefixing formula-like cells
 * prevents exported user text from executing as a formula while keeping the
 * original text visible to the user.
 *
 * @param {string} value - Normalized cell text.
 * @returns {string} Formula-neutralized cell text.
 */
function neutralizeSpreadsheetFormulaValue(value) {
  if (!value) {
    return value;
  }

  if (
    FORMULA_LIKE_CELL_PATTERN.test(value)
    || CONTROL_FORMULA_CELL_PATTERN.test(value)
  ) {
    return `'${value}`;
  }

  return value;
}

/**
 * Escapes one CSV cell according to RFC 4180-style quoting.
 *
 * Purpose: Quote every cell so commas, quotes, and newlines in job notes or
 * names remain one CSV field and cannot shift columns.
 *
 * @param {unknown} value - Raw database value for one export cell.
 * @returns {string} Quoted and escaped CSV cell.
 */
function escapeCsvCell(value) {
  const normalizedValue = neutralizeSpreadsheetFormulaValue(
    normalizeCsvCellValue(value)
  );

  return `"${normalizedValue.replace(/"/g, '""')}"`;
}

/**
 * Serializes exportable job rows into CSV text.
 *
 * Purpose: Keep the route handler focused on HTTP concerns while this helper
 * owns the stable export column order and escaping behavior.
 *
 * @param {object[]} jobs - Rows returned from the owner-scoped export query.
 * @returns {string} CSV content with a header row and trailing newline.
 */
export function serializeJobsToCsv(jobs = []) {
  const header = JOB_EXPORT_COLUMNS.join(',');
  const rows = jobs.map((job) => (
    JOB_EXPORT_COLUMNS
      .map((column) => escapeCsvCell(job?.[column]))
      .join(',')
  ));

  return `${[header, ...rows].join('\r\n')}\r\n`;
}

/**
 * Fetches one bounded page of owned jobs for CSV export.
 *
 * Purpose: Explicitly filters by authenticated owner and projects only the
 * user-facing export columns, including active and locked rows.
 *
 * @param {string} userId - Authenticated owner id from req._rateLimitUser.id.
 * @param {number} rangeStart - Inclusive Supabase range start.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{data: object[]|null, error: Error|object|null}>}
 */
async function fetchOwnedJobExportPage(userId, rangeStart, log = defaultLogger) {
  const rangeEnd = rangeStart + JOB_EXPORT_PAGE_SIZE - 1;

  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select(JOB_EXPORT_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(rangeStart, rangeEnd);

  if (error) {
    log.error(
      { err: error, operation: 'fetchOwnedJobExportPage', userId, rangeStart },
      'Failed to fetch jobs export page'
    );
    return { data: null, error };
  }

  if (!Array.isArray(data)) {
    const shapeError = new Error('Jobs export query returned an unexpected payload');
    log.error(
      { err: shapeError, operation: 'fetchOwnedJobExportPage', userId, rangeStart },
      'Jobs export page payload was invalid'
    );
    return { data: null, error: shapeError };
  }

  return { data, error: null };
}

/**
 * Builds a CSV export for all jobs owned by one authenticated user.
 *
 * Purpose: Provide a full active-plus-locked export through the server-owned
 * database boundary without accepting client-supplied ownership fields.
 *
 * @param {string} userId - Authenticated owner id from middleware context.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{data: {csv: string, rowCount: number}|null, error: Error|object|null}>}
 */
export async function getJobsCsvExportForUser(userId, log = defaultLogger) {
  if (!userId || typeof userId !== 'string') {
    return {
      data: null,
      error: new Error('Authenticated user id is required for job export'),
    };
  }

  try {
    const jobs = [];

    for (let rangeStart = 0; ; rangeStart += JOB_EXPORT_PAGE_SIZE) {
      const pageResult = await fetchOwnedJobExportPage(userId, rangeStart, log);

      if (pageResult.error) {
        return { data: null, error: pageResult.error };
      }

      jobs.push(...pageResult.data);

      if (pageResult.data.length < JOB_EXPORT_PAGE_SIZE) {
        break;
      }
    }

    return {
      data: {
        csv: serializeJobsToCsv(jobs),
        rowCount: jobs.length,
      },
      error: null,
    };
  } catch (error) {
    log.error(
      { err: error, operation: 'getJobsCsvExportForUser', userId },
      'Failed to build jobs CSV export'
    );
    return { data: null, error };
  }
}
