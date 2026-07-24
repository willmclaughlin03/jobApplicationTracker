/**
 * Suite B — UserProfile schema + DB round-trip integration tests
 *
 * Split into two blocks:
 *
 *   Block 1 — Zod validation (no infra required, runs in all environments)
 *     Fixtures from fixtures/profiles/:
 *       valid_full.json, valid_minimal.json
 *       invalid_angle_brackets.json
 *       invalid_oversize_experience.json   (21 entries, cap is 20)
 *       invalid_oversize_education.json    (11 entries, cap is 10)
 *       invalid_oversize_certifications.json (21 entries, cap is 20)
 *       invalid_bullet_too_long.json       (bullet > 400 chars)
 *
 *   Block 2 — DB round-trip (requires TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_KEY)
 *     Tests: upsert and read back, updated_at trigger monotonicity.
 *     Skipped with a clear message if Supabase infra is not configured.
 *
 * Block 2 setup requirements:
 *   - TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_KEY env vars
 *     for the isolated integration project
 *   - user_profiles table with updated_at trigger already migrated
 *   - A test user ID (UUID) in SUPABASE_TEST_USER_ID env var
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { UserProfile } from '../profile.js';

const {
  TEST_SUPABASE_ENV_NAMES,
  resolveDestructiveIntegrationEnvironment,
} = require('../../../testSupport/integrationEnvironment.js');
const {
  runIntegrationCleanup,
} = require('../../../testSupport/integrationCleanup.js');

const FIXTURES = join(__dirname, 'fixtures', 'profiles');

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

// ---------------------------------------------------------------------------
// Block 1 — Zod validation (no Supabase required)
// ---------------------------------------------------------------------------

describe('Suite B — Block 1: UserProfile Zod validation', () => {
  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  test('valid_full: parses successfully, shape preserved including array ordering', () => {
    const raw = loadFixture('valid_full.json');
    const result = UserProfile.safeParse(raw);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.summary).toBe(raw.summary);
    expect(result.data.experience).toHaveLength(raw.experience.length);
    expect(result.data.experience[0].company).toBe(raw.experience[0].company);
    expect(result.data.experience[1].company).toBe(raw.experience[1].company);
    expect(result.data.education[0].institution).toBe(raw.education[0].institution);
    expect(result.data.certifications).toEqual(raw.certifications);
  });

  test('valid_minimal: parses successfully (all arrays empty)', () => {
    const raw = loadFixture('valid_minimal.json');
    const result = UserProfile.safeParse(raw);

    expect(result.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Angle bracket rejection
  // -------------------------------------------------------------------------

  test('invalid_angle_brackets: fails with "Angle brackets are not permitted in profile fields."', () => {
    const raw = loadFixture('invalid_angle_brackets.json');
    const result = UserProfile.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) return;

    const messages = result.error.issues.map((i) => i.message);
    expect(messages).toContain('Angle brackets are not permitted in profile fields.');
  });

  // -------------------------------------------------------------------------
  // Array cap rejections
  // -------------------------------------------------------------------------

  test('invalid_oversize_experience: fails on experience array (21 > max 20)', () => {
    const raw = loadFixture('invalid_oversize_experience.json');
    const result = UserProfile.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) return;

    const experienceIssue = result.error.issues.find((i) =>
      i.path.includes('experience')
    );
    expect(experienceIssue).toBeDefined();
  });

  test('invalid_oversize_education: fails on education array (11 > max 10)', () => {
    const raw = loadFixture('invalid_oversize_education.json');
    const result = UserProfile.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) return;

    const educationIssue = result.error.issues.find((i) =>
      i.path.includes('education')
    );
    expect(educationIssue).toBeDefined();
  });

  test('invalid_oversize_certifications: fails on certifications array (21 > max 20)', () => {
    const raw = loadFixture('invalid_oversize_certifications.json');
    const result = UserProfile.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) return;

    const certIssue = result.error.issues.find((i) =>
      i.path.includes('certifications')
    );
    expect(certIssue).toBeDefined();
  });

  test('invalid_bullet_too_long: fails on experience bullet exceeding 400 chars', () => {
    const raw = loadFixture('invalid_bullet_too_long.json');
    const result = UserProfile.safeParse(raw);

    expect(result.success).toBe(false);
    if (result.success) return;

    const bulletIssue = result.error.issues.find((i) =>
      i.path.includes('bullets')
    );
    expect(bulletIssue).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Block 2 — DB round-trip (requires test Supabase infra)
// ---------------------------------------------------------------------------

const TEST_URL         = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const TEST_USER_ID     = process.env.SUPABASE_TEST_USER_ID;

const hasInfra = resolveDestructiveIntegrationEnvironment(process.env, {
  suiteName: 'Suite B',
  requiredNames: [
    TEST_SUPABASE_ENV_NAMES.url,
    TEST_SUPABASE_ENV_NAMES.serviceKey,
    'SUPABASE_TEST_USER_ID',
  ],
});

const describeOrSkip = hasInfra ? describe : describe.skip;

describeOrSkip('Suite B — Block 2: DB round-trip (requires TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_KEY + SUPABASE_TEST_USER_ID)', () => {
  let supabase;

  beforeAll(async () => {
    // Dynamically import to avoid module-level failures when env vars are absent.
    // Uses the service role key for test setup (bypasses RLS — test-only).
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  });

  afterAll(async () => {
    if (supabase) {
      await runIntegrationCleanup([
        {
          label: 'profile rows',
          cleanup: () => supabase
            .from('user_profiles')
            .delete()
            .eq('user_id', TEST_USER_ID),
        },
      ]);
    }
  });

  test('upsert valid_full profile, read back — shape preserved including array ordering', async () => {
    const raw = loadFixture('valid_full.json');
    const parsed = UserProfile.parse(raw);

    const { error: upsertError } = await supabase
      .from('user_profiles')
      .upsert({ user_id: TEST_USER_ID, ...parsed });

    expect(upsertError).toBeNull();

    const { data, error: selectError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', TEST_USER_ID)
      .single();

    expect(selectError).toBeNull();
    expect(data).toBeDefined();
    expect(data.summary).toBe(parsed.summary);
    expect(data.experience[0].company).toBe(parsed.experience[0].company);
    expect(data.education[0].institution).toBe(parsed.education[0].institution);
  });

  test('updated_at trigger fires and is monotonically increasing', async () => {
    const raw = loadFixture('valid_full.json');
    const parsed = UserProfile.parse(raw);

    // First upsert
    await supabase.from('user_profiles').upsert({ user_id: TEST_USER_ID, ...parsed });
    const { data: d1 } = await supabase
      .from('user_profiles')
      .select('updated_at')
      .eq('user_id', TEST_USER_ID)
      .single();
    const t1 = new Date(d1.updated_at).getTime();

    // Brief pause to ensure timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Second upsert with a change
    await supabase.from('user_profiles').upsert({
      user_id: TEST_USER_ID,
      ...parsed,
      summary: 'Updated summary for trigger test.',
    });
    const { data: d2 } = await supabase
      .from('user_profiles')
      .select('updated_at')
      .eq('user_id', TEST_USER_ID)
      .single();
    const t2 = new Date(d2.updated_at).getTime();

    expect(t2).toBeGreaterThan(t1);
  });
});
