/**
 * Formats a salary range for display.
 *
 * Purpose: Consistent salary display across table rows, mobile cards, and sidebar
 * Connects to: JobTableRow, JobCardMobile, JobStatsSidebar
 *
 * @param {number|null} min - Minimum salary
 * @param {number|null} max - Maximum salary
 * @returns {string} Formatted salary string (e.g. "$60k - $120k") or "—"
 */
const fmt = (val) => {
  if (val >= 1000) return `$${Math.round(val / 1000)}k`;
  return `$${val}`;
};

export function formatSalary(min, max) {
  if (min == null && max == null) return '\u2014';

  if (min != null && max != null) return `${fmt(min)} - ${fmt(max)}`;
  if (min != null) return `${fmt(min)}+`;
  return `Up to ${fmt(max)}`;
}

export function formatSalarySingle(val) {
  if (val == null) return '\u2014';
  return fmt(val);
}
