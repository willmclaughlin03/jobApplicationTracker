/**
 * Single source of truth for job application statuses
 *
 * Purpose: Centralized status definitions used by validation, UI, and database
 *
 * To add a new status:
 * 1. Add entry to STATUS_CONFIG below
 * 2. All exports will automatically include it
 */

export const STATUS_CONFIG = {
  applied: {
    label: 'Applied',
    bgClass: 'bg-blue-100',
    textClass: 'text-blue-800',
    dotColor: 'bg-blue-500',
    order: 1
  },
  interviewing: {
    label: 'Interviewing',
    bgClass: 'bg-orange-100',
    textClass: 'text-orange-800',
    dotColor: 'bg-orange-500',
    order: 2
  },
  offered: {
    label: 'Offered',
    bgClass: 'bg-green-100',
    textClass: 'text-green-800',
    dotColor: 'bg-green-500',
    order: 3
  },
  accepted: {
    label: 'Accepted',
    bgClass: 'bg-green-200',
    textClass: 'text-green-900',
    dotColor: 'bg-green-700',
    order: 4
  },
  rejected: {
    label: 'Rejected',
    bgClass: 'bg-red-100',
    textClass: 'text-red-800',
    dotColor: 'bg-red-500',
    order: 5
  }
};

/**
 * Array of valid status values - used by Zod enum validation
 * @type {string[]}
 */
export const STATUSES = Object.keys(STATUS_CONFIG);

/**
 * Status options for dropdown menus - sorted by order
 * @type {Array<{value: string, label: string}>}
 */
export const STATUS_OPTIONS = Object.entries(STATUS_CONFIG)
  .sort(([, a], [, b]) => a.order - b.order)
  .map(([value, config]) => ({
    value,
    label: config.label
  }));

/**
 * Status colors for badges/pills - combined bg and text classes
 * @type {Object<string, string>}
 */
export const STATUS_COLORS = Object.fromEntries(
  Object.entries(STATUS_CONFIG).map(([value, config]) => [
    value,
    `${config.bgClass} ${config.textClass}`
  ])
);

/**
 * Status dot colors for sidebar indicators
 * @type {Object<string, string>}
 */
export const STATUS_DOT_COLORS = Object.fromEntries(
  Object.entries(STATUS_CONFIG).map(([value, config]) => [
    value,
    config.dotColor
  ])
);

/**
 * Default status for new job applications
 * @type {string}
 */
export const DEFAULT_STATUS = 'applied';

/**
 * Initial form data for new job forms
 * @type {Object}
 */
export const INITIAL_FORM_DATA = {
  company: '',
  position: '',
  status: DEFAULT_STATUS,
  notes: ''
};