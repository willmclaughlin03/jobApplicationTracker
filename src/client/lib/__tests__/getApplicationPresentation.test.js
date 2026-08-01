const { STATUS_CONFIG } = require('../../../shared/constants/statuses.js');
const { getApplicationPresentation } = require('../getApplicationPresentation.js');

describe('getApplicationPresentation', () => {
  it('returns canonical status and safely formatted status-date presentation', () => {
    expect(getApplicationPresentation({
      notes: 'Follow up next week',
      status: 'applied',
      status_date: '2026-07-29T23:30:00.000Z',
    })).toEqual({
      notes: 'Follow up next week',
      hasNotes: true,
      isLongNotes: false,
      status: STATUS_CONFIG.applied,
      statusDate: 'Jul 29, 2026',
    });
  });

  it('marks only nonblank notes longer than 90 characters as long', () => {
    expect(getApplicationPresentation({ notes: 'A'.repeat(90) }).isLongNotes).toBe(false);
    expect(getApplicationPresentation({ notes: 'A'.repeat(91) }).isLongNotes).toBe(true);

    expect(getApplicationPresentation({ notes: ' '.repeat(91) })).toMatchObject({
      hasNotes: false,
      isLongNotes: false,
    });
  });

  it('uses safe fallbacks while preserving a zero epoch status date', () => {
    expect(getApplicationPresentation({
      notes: null,
      status: 'future-status',
      status_date: 'not-a-date',
    })).toEqual({
      notes: '',
      hasNotes: false,
      isLongNotes: false,
      status: undefined,
      statusDate: '\u2014',
    });

    expect(getApplicationPresentation({ status_date: 0 }).statusDate).toBe('Jan 1, 1970');
  });
});
