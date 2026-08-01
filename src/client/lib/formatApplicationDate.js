/**
 * Format an application timestamp for stable calendar-date display.
 *
 * Purpose: shared application rows and cards need identical UTC date semantics
 * without exposing Invalid Date text for missing or malformed job fields.
 *
 * @param {unknown} value - Raw date-like job field.
 * @returns {string} Formatted date or an em dash when unavailable.
 */
export function formatApplicationDate(value) {
  if (!value) {
    return '\u2014';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '\u2014';
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
