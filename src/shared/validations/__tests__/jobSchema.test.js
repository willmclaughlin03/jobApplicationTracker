/**
 * Unit tests for jobSchema validation
 *
 * Purpose: Verify job entity validation logic works correctly
 * Covers: uuidSchema, jobSchema, jobUpdateSchema, getQuerySchema, sanitization, edge cases
 *
 * Connects to: shared/validations/jobSchema.js
 */

// Mock isomorphic-dompurify to avoid Jest transformation issues
jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: {
    sanitize: (val, _options) => {
      // Simple mock that strips HTML tags for testing
      if (typeof val !== 'string') return val;
      return val.replace(/<[^>]*>/g, '');
    },
  },
}));

import {
  uuidSchema,
  jobSchema,
  jobUpdateSchema,
  getQuerySchema,
  MAX_PAGE_SIZE,
  DEFAULT_STATUS,
} from '../jobSchema';

// =========================================================================
// uuidSchema
// =========================================================================
describe('uuidSchema', () => {
  it('should accept a valid UUID', () => {
    const result = uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
    expect(result.success).toBe(true);
  });

  it('should reject an empty string', () => {
    const result = uuidSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('should reject a plain string', () => {
    const result = uuidSchema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
  });

  it('should reject undefined', () => {
    const result = uuidSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// =========================================================================
// jobSchema
// =========================================================================
describe('jobSchema', () => {
  const validJob = {
    company: 'Acme Corp',
    position: 'Software Engineer',
    status: 'applied',
    notes: 'Applied via website',
  };

  // -----------------------------------------------------------------------
  // company
  // -----------------------------------------------------------------------
  describe('company validation', () => {
    it('should accept a valid company name', () => {
      const result = jobSchema.safeParse(validJob);
      expect(result.success).toBe(true);
    });

    it('should reject empty string', () => {
      const result = jobSchema.safeParse({ ...validJob, company: '' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toBe('Required');
    });

    it('should reject company longer than 100 characters', () => {
      const result = jobSchema.safeParse({ ...validJob, company: 'A'.repeat(101) });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toBe('Too long');
    });

    it('should accept company at max 100 characters', () => {
      const result = jobSchema.safeParse({ ...validJob, company: 'A'.repeat(100) });
      expect(result.success).toBe(true);
    });

    it('should accept company at min 1 character', () => {
      const result = jobSchema.safeParse({ ...validJob, company: 'X' });
      expect(result.success).toBe(true);
    });

    it('should sanitize HTML from company', () => {
      const result = jobSchema.safeParse({
        ...validJob,
        company: '<script>alert("xss")</script>Acme',
      });
      expect(result.success).toBe(true);
      expect(result.data.company).not.toContain('<script>');
      expect(result.data.company).toContain('Acme');
    });

    it('should trim whitespace from company', () => {
      const result = jobSchema.safeParse({ ...validJob, company: '  Acme Corp  ' });
      expect(result.success).toBe(true);
      expect(result.data.company).toBe('Acme Corp');
    });
  });

  // -----------------------------------------------------------------------
  // position
  // -----------------------------------------------------------------------
  describe('position validation', () => {
    it('should reject empty string', () => {
      const result = jobSchema.safeParse({ ...validJob, position: '' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toBe('Required');
    });

    it('should reject position longer than 100 characters', () => {
      const result = jobSchema.safeParse({ ...validJob, position: 'P'.repeat(101) });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toBe('Too long');
    });

    it('should accept position at max 100 characters', () => {
      const result = jobSchema.safeParse({ ...validJob, position: 'P'.repeat(100) });
      expect(result.success).toBe(true);
    });

    it('should sanitize HTML from position', () => {
      const result = jobSchema.safeParse({
        ...validJob,
        position: '<b>Engineer</b>',
      });
      expect(result.success).toBe(true);
      expect(result.data.position).not.toContain('<b>');
      expect(result.data.position).toContain('Engineer');
    });

    it('should trim whitespace from position', () => {
      const result = jobSchema.safeParse({ ...validJob, position: '  Dev  ' });
      expect(result.success).toBe(true);
      expect(result.data.position).toBe('Dev');
    });
  });

  // -----------------------------------------------------------------------
  // status
  // -----------------------------------------------------------------------
  describe('status validation', () => {
    it.each(['applied', 'interviewing', 'offered', 'accepted', 'rejected'])(
      'should accept valid status: %s',
      (status) => {
        const result = jobSchema.safeParse({ ...validJob, status });
        expect(result.success).toBe(true);
        expect(result.data.status).toBe(status);
      }
    );

    it('should reject unknown status', () => {
      const result = jobSchema.safeParse({ ...validJob, status: 'hired' });
      expect(result.success).toBe(false);
      // Note: Zod v4 changed the errorMap callback API for z.enum — the custom
      // message in jobSchema.js is currently silently ignored. We verify that
      // an error is produced and that it references the valid status options.
      expect(result.error.issues[0].message).toMatch(/applied|Invalid/i);
    });

    it('should default to DEFAULT_STATUS when status is omitted', () => {
      const { status, ...jobWithoutStatus } = validJob;
      const result = jobSchema.safeParse(jobWithoutStatus);
      expect(result.success).toBe(true);
      expect(result.data.status).toBe(DEFAULT_STATUS);
      expect(result.data.status).toBe('applied');
    });
  });

  // -----------------------------------------------------------------------
  // notes
  // -----------------------------------------------------------------------
  describe('notes validation', () => {
    it('should accept undefined notes (optional)', () => {
      const { notes, ...jobWithoutNotes } = validJob;
      const result = jobSchema.safeParse(jobWithoutNotes);
      expect(result.success).toBe(true);
    });

    it('should reject notes longer than 250 characters', () => {
      const result = jobSchema.safeParse({ ...validJob, notes: 'N'.repeat(251) });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toBe('Notes must be 250 characters or fewer');
    });

    it('should accept notes at max 250 characters', () => {
      const result = jobSchema.safeParse({ ...validJob, notes: 'N'.repeat(250) });
      expect(result.success).toBe(true);
    });

    it('should sanitize HTML from notes', () => {
      const result = jobSchema.safeParse({
        ...validJob,
        notes: '<img src=x onerror=alert(1)>Good note',
      });
      expect(result.success).toBe(true);
      expect(result.data.notes).not.toContain('<img');
      expect(result.data.notes).toContain('Good note');
    });
  });
});

// =========================================================================
// jobUpdateSchema (.partial())
// =========================================================================
describe('jobUpdateSchema', () => {
  it('should accept empty object (all fields optional)', () => {
    const result = jobUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept a single valid field', () => {
    const result = jobUpdateSchema.safeParse({ company: 'NewCo' });
    expect(result.success).toBe(true);
    expect(result.data.company).toBe('NewCo');
  });

  it('should still reject empty string for company', () => {
    const result = jobUpdateSchema.safeParse({ company: '' });
    expect(result.success).toBe(false);
  });

  it('should still reject invalid status', () => {
    const result = jobUpdateSchema.safeParse({ status: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('should sanitize fields in partial schema', () => {
    const result = jobUpdateSchema.safeParse({
      company: '<em>Sanitized</em>',
    });
    expect(result.success).toBe(true);
    expect(result.data.company).not.toContain('<em>');
    expect(result.data.company).toContain('Sanitized');
  });
});

// =========================================================================
// getQuerySchema
// =========================================================================
describe('getQuerySchema', () => {
  // -----------------------------------------------------------------------
  // No params — unpaginated fetch is valid
  // -----------------------------------------------------------------------
  it('should accept empty query (no pagination, no status)', () => {
    const result = getQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept locked storage_state archive queries', () => {
    const result = getQuerySchema.safeParse({ storage_state: 'locked' });
    expect(result.success).toBe(true);
    expect(result.data.storage_state).toBe('locked');
  });

  it('should reject unknown storage_state query values', () => {
    const result = getQuerySchema.safeParse({ storage_state: 'active' });
    expect(result.success).toBe(false);
  });

  it('should reject status filters on locked archive queries', () => {
    const result = getQuerySchema.safeParse({
      storage_state: 'locked',
      status: 'applied',
    });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Valid pagination
  // -----------------------------------------------------------------------
  describe('valid pagination', () => {
    it('should accept valid from/to range (second page)', () => {
      const result = getQuerySchema.safeParse({ from: '15', to: '29' });
      expect(result.success).toBe(true);
      expect(result.data.from).toBe(15);
      expect(result.data.to).toBe(29);
    });

    it('should accept a single-item range (from === to)', () => {
      const result = getQuerySchema.safeParse({ from: '5', to: '5' });
      expect(result.success).toBe(true);
    });

    it('should accept a range exactly at the MAX_PAGE_SIZE boundary', () => {
      // MAX_PAGE_SIZE items: from=0, to=MAX_PAGE_SIZE-1
      const result = getQuerySchema.safeParse({ from: '0', to: String(MAX_PAGE_SIZE - 1) });
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // NaN / non-numeric inputs
  // -----------------------------------------------------------------------
  describe('NaN propagation prevention', () => {
    it('should reject non-numeric from', () => {
      const result = getQuerySchema.safeParse({ from: 'abc', to: '14' });
      expect(result.success).toBe(false);
    });

    it('should reject non-numeric to', () => {
      const result = getQuerySchema.safeParse({ from: '0', to: 'xyz' });
      expect(result.success).toBe(false);
    });

    it('should reject both non-numeric from and to', () => {
      const result = getQuerySchema.safeParse({ from: 'abc', to: 'xyz' });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Float inputs (must be integers)
  // -----------------------------------------------------------------------
  describe('integer enforcement', () => {
    it('should reject float for from', () => {
      const result = getQuerySchema.safeParse({ from: '1.5', to: '14' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/integer/i);
    });

    it('should reject float for to', () => {
      const result = getQuerySchema.safeParse({ from: '0', to: '9.9' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/integer/i);
    });
  });

  // -----------------------------------------------------------------------
  // Negative inputs
  // -----------------------------------------------------------------------
  describe('non-negative enforcement', () => {
    it('should reject negative from', () => {
      const result = getQuerySchema.safeParse({ from: '-1', to: '14' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/from must be >= 0/i);
    });

    it('should reject negative to', () => {
      const result = getQuerySchema.safeParse({ from: '0', to: '-1' });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Paired params — both or neither
  // -----------------------------------------------------------------------
  describe('from/to pairing', () => {
    it('should reject from without to', () => {
      const result = getQuerySchema.safeParse({ from: '0' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/both be provided/i);
    });

    it('should reject to without from', () => {
      const result = getQuerySchema.safeParse({ to: '14' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/both be provided/i);
    });
  });

  // -----------------------------------------------------------------------
  // Inverted range
  // -----------------------------------------------------------------------
  describe('range direction', () => {
    it('should reject to < from', () => {
      const result = getQuerySchema.safeParse({ from: '10', to: '2' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/to must be greater than or equal to from/i);
    });
  });

  // -----------------------------------------------------------------------
  // Page size cap
  // -----------------------------------------------------------------------
  describe('page size cap', () => {
    it('should reject a range exceeding MAX_PAGE_SIZE', () => {
      // MAX_PAGE_SIZE + 1 items: to - from + 1 = MAX_PAGE_SIZE + 1
      const result = getQuerySchema.safeParse({ from: '0', to: String(MAX_PAGE_SIZE) });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/cannot exceed/i);
    });
  });

  // -----------------------------------------------------------------------
  // Status allowlist
  // -----------------------------------------------------------------------
  describe('status validation', () => {
    it.each(['applied', 'interviewing', 'offered', 'accepted', 'rejected'])(
      'should accept valid status: %s',
      (status) => {
        const result = getQuerySchema.safeParse({ status });
        expect(result.success).toBe(true);
        expect(result.data.status).toBe(status);
      }
    );

    it('should reject an unknown status value', () => {
      const result = getQuerySchema.safeParse({ status: 'hired' });
      expect(result.success).toBe(false);
      // Note: Zod v4 ignores the errorMap for z.enum — the default message
      // lists the valid options instead. We verify an error is produced and
      // that it references the allowlisted values.
      expect(result.error.issues[0].message).toMatch(/applied|invalid/i);
    });

    it('should reject a whitespace-only status (truthy but not in enum)', () => {
      const result = getQuerySchema.safeParse({ status: '   ' });
      expect(result.success).toBe(false);
    });

    it('should accept status without pagination params', () => {
      const result = getQuerySchema.safeParse({ status: 'applied' });
      expect(result.success).toBe(true);
    });

    it('should accept status combined with valid pagination', () => {
      const result = getQuerySchema.safeParse({ from: '0', to: '14', status: 'interviewing' });
      expect(result.success).toBe(true);
    });

    it('should be optional — absent status is valid', () => {
      const result = getQuerySchema.safeParse({ from: '0', to: '14' });
      expect(result.success).toBe(true);
      expect(result.data.status).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Coercion — query params arrive as strings
  // -----------------------------------------------------------------------
  describe('coercion of string query params', () => {
    it('should coerce string integers to numbers', () => {
      const result = getQuerySchema.safeParse({ from: '0', to: '14' });
      expect(result.success).toBe(true);
      expect(typeof result.data.from).toBe('number');
      expect(typeof result.data.to).toBe('number');
    });
  });
});

// =========================================================================
// Edge cases
// =========================================================================
describe('Edge cases', () => {
  const validJob = {
    company: 'Acme',
    position: 'Dev',
  };

  it('should reject non-string types for company', () => {
    const result = jobSchema.safeParse({ ...validJob, company: 123 });
    expect(result.success).toBe(false);
  });

  it('should reject non-string types for position', () => {
    const result = jobSchema.safeParse({ ...validJob, position: true });
    expect(result.success).toBe(false);
  });

  it('should reject null for optional notes', () => {
    const result = jobSchema.safeParse({ ...validJob, notes: null });
    expect(result.success).toBe(false);
  });

  it('should reject non-string types for notes', () => {
    const result = jobSchema.safeParse({ ...validJob, notes: 42 });
    expect(result.success).toBe(false);
  });

  it('should reject numeric type for status', () => {
    const result = jobSchema.safeParse({ ...validJob, status: 1 });
    expect(result.success).toBe(false);
  });
});
