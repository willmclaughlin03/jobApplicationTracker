/**
 * Tests for the shared descending jobs keyset cursor.
 *
 * Purpose: dashboard and export reads depend on identical validation,
 * PostgREST filtering, and cursor-progress semantics.
 */

const {
  buildJobReadCursorFilter,
  doesJobReadCursorAdvance,
  getJobReadCursor,
} = require('../jobReadCursor.js');

const NEWER_CURSOR = {
  createdAt: '2026-07-11T12:00:00.000Z',
  id: '00000000-0000-4000-8000-000000000002',
};
const OLDER_CURSOR = {
  createdAt: '2026-07-10T12:00:00.000Z',
  id: '00000000-0000-4000-8000-000000000999',
};

describe('jobReadCursor', () => {
  it('extracts a valid database cursor and builds the descending filter', () => {
    const cursor = getJobReadCursor({
      created_at: NEWER_CURSOR.createdAt,
      id: NEWER_CURSOR.id,
    });

    expect(cursor).toEqual(NEWER_CURSOR);
    expect(buildJobReadCursorFilter(cursor)).toBe(
      'created_at.lt.' + NEWER_CURSOR.createdAt + ','
      + 'and(created_at.eq.' + NEWER_CURSOR.createdAt + ',id.lt.' + NEWER_CURSOR.id + ')'
    );
  });

  it.each([
    ['missing row', null],
    ['missing timestamp', { id: NEWER_CURSOR.id }],
    ['invalid timestamp', { created_at: 'not-a-date', id: NEWER_CURSOR.id }],
    ['missing id', { created_at: NEWER_CURSOR.createdAt }],
    ['non-UUID id', { created_at: NEWER_CURSOR.createdAt, id: 'job-id' }],
  ])('rejects malformed database cursors: %s', (_label, row) => {
    expect(getJobReadCursor(row)).toBeNull();
  });

  it('requires strict descending progress by timestamp or id tie-breaker', () => {
    expect(doesJobReadCursorAdvance(null, NEWER_CURSOR)).toBe(true);
    expect(doesJobReadCursorAdvance(NEWER_CURSOR, OLDER_CURSOR)).toBe(true);
    expect(doesJobReadCursorAdvance(NEWER_CURSOR, {
      ...NEWER_CURSOR,
      id: '00000000-0000-4000-8000-000000000001',
    })).toBe(true);
    expect(doesJobReadCursorAdvance(NEWER_CURSOR, NEWER_CURSOR)).toBe(false);
    expect(doesJobReadCursorAdvance(OLDER_CURSOR, NEWER_CURSOR)).toBe(false);
    expect(doesJobReadCursorAdvance(NEWER_CURSOR, null)).toBe(false);
  });

  it('preserves sub-millisecond timestamp precision when checking progress', () => {
    const previousCursor = {
      createdAt: '2026-07-11T12:00:00.123456+00:00',
      id: '00000000-0000-4000-8000-000000000001',
    };
    const nextCursor = {
      createdAt: '2026-07-11T12:00:00.123123+00:00',
      id: '00000000-0000-4000-8000-000000000999',
    };

    expect(doesJobReadCursorAdvance(previousCursor, nextCursor)).toBe(true);
  });

  it('throws before building a raw filter from an invalid cursor', () => {
    expect(() => buildJobReadCursorFilter({
      createdAt: NEWER_CURSOR.createdAt,
      id: 'unsafe-filter-value',
    })).toThrow(TypeError);
  });
});
