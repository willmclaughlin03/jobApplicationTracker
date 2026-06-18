/**
 * Tests for jobExportService.
 *
 * Purpose: Verify owner-scoped CSV export behavior for active and locked jobs
 * without exposing user ids, storage metadata, or unescaped CSV content.
 */

const mockFrom = jest.fn();

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    from: mockFrom,
  },
}));

jest.mock('../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  JOB_EXPORT_COLUMNS,
  getJobsCsvExportForUser,
  serializeJobsToCsv,
} = require('../jobExportService.js');

/**
 * Creates a chainable Supabase query fake.
 *
 * Purpose: service tests assert exact query construction while allowing the
 * final awaited query to resolve like the Supabase client.
 *
 * @param {object} resolvedValue - Supabase-like terminal query response.
 * @returns {Proxy} Chainable thenable query fake with recorded calls.
 */
function fakeQuery(resolvedValue) {
  const _calls = {};

  const chain = new Proxy({}, {
    get(_, prop) {
      if (prop === '_calls') return _calls;

      if (prop === 'then') {
        return (resolve, reject) => Promise.resolve(resolvedValue).then(resolve, reject);
      }

      return (...args) => {
        _calls[prop] = _calls[prop] || [];
        _calls[prop].push(args);
        return chain;
      };
    },
  });

  return chain;
}

/**
 * Builds export rows for pagination tests.
 *
 * Purpose: large export tests need deterministic rows without embedding a huge
 * hand-written fixture in the test body.
 *
 * @param {number} count - Number of rows to create.
 * @param {number} offset - Numeric suffix offset for generated values.
 * @returns {object[]} Exportable job rows.
 */
function buildExportRows(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const rowNumber = offset + index + 1;

    return {
      company: `Company ${rowNumber}`,
      position: `Position ${rowNumber}`,
      status: 'applied',
      notes: `Notes ${rowNumber}`,
      created_at: `2026-06-18T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    };
  });
}

describe('serializeJobsToCsv', () => {
  it('returns only the user-facing header row when there are no jobs', () => {
    expect(serializeJobsToCsv([])).toBe('company,position,status,notes,created_at\r\n');
  });

  it('escapes commas, quotes, newlines, nulls, and formula-like cells', () => {
    const csv = serializeJobsToCsv([
      {
        company: '=Acme, Inc.',
        position: 'Engineer "Lead"',
        status: 'applied',
        notes: 'Line one\nLine "two"',
        created_at: '2026-06-18T00:00:00.000Z',
      },
      {
        company: null,
        position: '+Ops',
        status: '@status',
        notes: '-note',
        created_at: null,
      },
    ]);

    expect(csv.startsWith('company,position,status,notes,created_at\r\n')).toBe(true);
    expect(csv).toContain('"\'=Acme, Inc."');
    expect(csv).toContain('"Engineer ""Lead"""');
    expect(csv).toContain('"Line one\nLine ""two"""');
    expect(csv).toContain('"\'+Ops"');
    expect(csv).toContain('"\'@status"');
    expect(csv).toContain('"\'-note"');
    expect(csv).toContain('"","\'+Ops"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('getJobsCsvExportForUser', () => {
  const userId = 'user-export-123';
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches all owned rows through the service boundary with an export allowlist', async () => {
    const exportRows = [
      {
        company: 'Active Corp',
        position: 'Engineer',
        status: 'applied',
        notes: 'Active notes',
        created_at: '2026-06-18T00:00:00.000Z',
        user_id: 'should-not-export',
        storage_state: 'active',
      },
      {
        company: 'Locked Corp',
        position: 'Analyst',
        status: 'interviewing',
        notes: 'Locked notes',
        created_at: '2026-06-17T00:00:00.000Z',
        locked_reason: 'premium_to_free_over_plan_limit',
      },
    ];
    const query = fakeQuery({ data: exportRows, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsCsvExportForUser(userId, mockLog);

    expect(result.error).toBeNull();
    expect(result.data.rowCount).toBe(2);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(query._calls.select).toEqual([[JOB_EXPORT_COLUMNS.join(',')]]);
    expect(query._calls.eq).toEqual([['user_id', userId]]);
    expect(query._calls.order).toEqual([['created_at', { ascending: false }]]);
    expect(query._calls.range).toEqual([[0, 999]]);
    expect(JSON.stringify(query._calls.eq)).not.toContain('storage_state');
    expect(result.data.csv).toContain('"Active Corp"');
    expect(result.data.csv).toContain('"Locked Corp"');
    expect(result.data.csv).not.toContain('should-not-export');
    expect(result.data.csv).not.toContain('premium_to_free_over_plan_limit');
  });

  it('paginates until a short page is returned', async () => {
    const firstPage = buildExportRows(1000);
    const secondPage = buildExportRows(1, 1000);
    const firstQuery = fakeQuery({ data: firstPage, error: null });
    const secondQuery = fakeQuery({ data: secondPage, error: null });
    mockFrom
      .mockReturnValueOnce(firstQuery)
      .mockReturnValueOnce(secondQuery);

    const result = await getJobsCsvExportForUser(userId, mockLog);

    expect(result.error).toBeNull();
    expect(result.data.rowCount).toBe(1001);
    expect(mockFrom).toHaveBeenCalledTimes(2);
    expect(firstQuery._calls.range).toEqual([[0, 999]]);
    expect(secondQuery._calls.range).toEqual([[1000, 1999]]);
  });

  it('returns and logs database errors without exporting partial CSV', async () => {
    const dbError = new Error('database unavailable');
    mockFrom.mockReturnValueOnce(fakeQuery({ data: null, error: dbError }));

    const result = await getJobsCsvExportForUser(userId, mockLog);

    expect(result.data).toBeNull();
    expect(result.error).toBe(dbError);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: dbError,
        operation: 'fetchOwnedJobExportPage',
        userId,
        rangeStart: 0,
      }),
      'Failed to fetch jobs export page'
    );
  });

  it('fails before querying when the authenticated user id is missing', async () => {
    const result = await getJobsCsvExportForUser('', mockLog);

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
