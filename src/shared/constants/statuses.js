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
    borderClass: 'border-blue-300',
    dashboardClass: 'border-sky-400/40 bg-sky-400/10 text-sky-200',
    dotColor: 'bg-blue-500',
    hexColor: '#3b82f6',
    order: 1
  },
  interviewing: {
    label: 'Interviewing',
    bgClass: 'bg-orange-100',
    textClass: 'text-orange-800',
    borderClass: 'border-orange-300',
    dashboardClass: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
    dotColor: 'bg-orange-500',
    hexColor: '#f97316',
    order: 2
  },
  offered: {
    label: 'Offered',
    bgClass: 'bg-green-100',
    textClass: 'text-green-800',
    borderClass: 'border-green-300',
    dashboardClass: 'border-violet-400/40 bg-violet-400/10 text-violet-200',
    dotColor: 'bg-green-500',
    hexColor: '#22c55e',
    order: 3
  },
  accepted: {
    label: 'Accepted',
    bgClass: 'bg-green-200',
    textClass: 'text-green-900',
    borderClass: 'border-green-400',
    dashboardClass: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200',
    dotColor: 'bg-green-700',
    hexColor: '#15803d',
    order: 4
  },
  rejected: {
    label: 'Rejected',
    bgClass: 'bg-red-100',
    textClass: 'text-red-800',
    borderClass: 'border-red-300',
    dashboardClass: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
    dotColor: 'bg-red-500',
    hexColor: '#ef4444',
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
    `${config.bgClass} ${config.textClass} ${config.borderClass}`
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
 * Status hex colors for SVG chart fills
 * @type {Object<string, string>}
 */
export const STATUS_HEX_COLORS = Object.fromEntries(
  Object.entries(STATUS_CONFIG).map(([value, config]) => [
    value,
    config.hexColor
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
  notes: '',
  salary_min: '',
  salary_max: '',
};
