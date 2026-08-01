const { formatApplicationDate } = require('../formatApplicationDate.js');

describe('formatApplicationDate', () => {
  it.each([undefined, null, '', 'not-a-date'])(
    'returns an em dash for unavailable value %p',
    value => {
      expect(formatApplicationDate(value)).toBe('\u2014');
    }
  );

  it('formats calendar dates in UTC across a local-date boundary', () => {
    expect(formatApplicationDate('2026-07-30T23:30:00-04:00')).toBe('Jul 31, 2026');
  });
});
