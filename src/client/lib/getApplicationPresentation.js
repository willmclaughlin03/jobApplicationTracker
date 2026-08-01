import { STATUS_CONFIG } from '../../shared/constants/statuses.js';
import { formatApplicationDate } from './formatApplicationDate.js';

/**
 * Derive the shared notes and status presentation used by application results.
 *
 * Purpose: desktop rows and mobile cards must apply identical notes thresholds,
 * status configuration, and safe status-date formatting for the same job.
 *
 * @param {object} job - Supported application data.
 * @returns {{notes: string, hasNotes: boolean, isLongNotes: boolean, status: object|undefined, statusDate: string}} Shared presentation values.
 */
export function getApplicationPresentation(job) {
  const notes = typeof job.notes === 'string' ? job.notes : '';
  const hasNotes = notes.trim().length > 0;

  return {
    notes,
    hasNotes,
    isLongNotes: hasNotes && notes.length > 90,
    status: STATUS_CONFIG[job.status],
    statusDate: formatApplicationDate(job.status_date),
  };
}
