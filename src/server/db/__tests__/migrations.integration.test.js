/**
 * Suite A — Migration + RLS integration tests
 *
 * Historical harness for the four pre-billing schema migrations against a real
 * test Supabase instance. Also verifies RLS policies on the four installed
 * tables when the schema already exists in the integration environment.
 *
 * Prerequisites (ALL required before this suite can run):
 *   1. Supabase project (the app's pre-prod instance is reused — see env vars)
 *   2. Env vars: TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY,
 *                TEST_SUPABASE_ANON_KEY
 *   3. Historical migration SQL files present under src/server/db/migrations/:
 *        001_user_profiles.sql
 *        002_tailor_cache.sql
 *        003_abuse_counters.sql
 *        004_daily_spend.sql
 *      Under the current repo policy these files are not stored in source
 *      control. The schema was applied directly via the Supabase console
 *      during Phase 0 development, so repo-only replay is unavailable.
 *   4. Two test user emails (SUPABASE_TEST_USER_A_EMAIL,
 *      SUPABASE_TEST_USER_B_EMAIL). The suite creates the auth users via the
 *      admin API and signs them in via admin-generated magic links — no
 *      passwords required (the project uses OAuth in normal use).
 *
 * ⚠️  BLOCKER: Repo-only migration replay is unavailable because the original
 *     SQL files are not present under the current local-only policy. Migration
 *     run tests (A1, A2) stay blocked; RLS tests (A3–A11) may still run
 *     against an already-migrated test instance.
 *
 * Test structure:
 *   A1  – Run four migrations in order on a fresh schema, no errors
 *   A2  – user_profiles schema: insert row, verify columns + types
 *   A3  – user_profiles updated_at trigger: t2 > t1 after update
 *   A4  – user_profiles RLS: user can read own row
 *   A5  – user_profiles RLS: user can update own row
 *   A6  – user_profiles RLS: user cannot read another user's row
 *   A7  – user_profiles RLS: user cannot update another user's row
 *   A8  – tailor_cache RLS: user can insert + select own hash
 *   A9  – tailor_cache RLS: user cannot read another user's cache row
 *   A10 – abuse_counters RLS: authenticated user sees zero rows (service-role only)
 *   A11 – daily_spend RLS: authenticated user sees zero rows (service-role only)
 *   A12 – daily_spend UTC date: stored date matches UTC date regardless of client TZ
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const {
  TEST_SUPABASE_ENV_NAMES,
  resolveDestructiveIntegrationEnvironment,
} = require('../../../testSupport/integrationEnvironment.js');

const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const TEST_ANON_KEY = process.env[TEST_SUPABASE_ENV_NAMES.anonKey];

const USER_A_EMAIL = process.env.SUPABASE_TEST_USER_A_EMAIL;
const USER_B_EMAIL = process.env.SUPABASE_TEST_USER_B_EMAIL;

const hasInfra = resolveDestructiveIntegrationEnvironment(process.env, {
  suiteName: 'Suite A',
  requiredNames: [
    TEST_SUPABASE_ENV_NAMES.url,
    TEST_SUPABASE_ENV_NAMES.serviceKey,
    TEST_SUPABASE_ENV_NAMES.anonKey,
    'SUPABASE_TEST_USER_A_EMAIL',
    'SUPABASE_TEST_USER_B_EMAIL',
  ],
});

/**
 * Sign a user in without a password by minting a magic link via the admin API
 * and exchanging the hashed token for a session via verifyOtp. Used because the
 * app authenticates real users via OAuth — there are no passwords to log in with.
 */
async function signInAsUser(createClient, adminClient, email) {
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError) throw linkError;

  const tokenHash = linkData?.properties?.hashed_token;
  if (!tokenHash) throw new Error(`generateLink returned no hashed_token for ${email}`);

  const userClient = createClient(TEST_URL, TEST_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error: verifyError } = await userClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  });
  if (verifyError) throw verifyError;

  return userClient;
}

const describeOrSkip = hasInfra ? describe : describe.skip;

describeOrSkip('Suite A — Migration + RLS integration', () => {
  let serviceClient;   // service-role client, bypasses RLS
  let clientA;         // authenticated as userA
  let clientB;         // authenticated as userB
  let userAId;
  let userBId;

  const MIGRATION_FILES = [
    '001_user_profiles.sql',
    '002_tailor_cache.sql',
    '003_abuse_counters.sql',
    '004_daily_spend.sql',
  ];

  const hasMigrationFiles = MIGRATION_FILES.every((f) =>
    existsSync(join(MIGRATIONS_DIR, f))
  );

  beforeAll(async () => {
    const { createClient } = await import('@supabase/supabase-js');

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Create or retrieve test users via the admin API
    const adminAuth = serviceClient.auth.admin;

    // Create test users without passwords (project uses OAuth in normal use).
    // createUser is idempotent-ish: returns an error on conflict, in which case
    // we look the user up via listUsers below.
    const { data: uaData } = await adminAuth.createUser({
      email: USER_A_EMAIL,
      email_confirm: true,
    });
    userAId = uaData?.user?.id;

    const { data: ubData } = await adminAuth.createUser({
      email: USER_B_EMAIL,
      email_confirm: true,
    });
    userBId = ubData?.user?.id;

    // If users already exist (re-run), look them up
    if (!userAId || !userBId) {
      const { data } = await adminAuth.listUsers();
      userAId = userAId || data?.users?.find((u) => u.email === USER_A_EMAIL)?.id;
      userBId = userBId || data?.users?.find((u) => u.email === USER_B_EMAIL)?.id;
    }

    // Sign in as each user via admin-generated magic links (no passwords).
    clientA = await signInAsUser(createClient, serviceClient, USER_A_EMAIL);
    clientB = await signInAsUser(createClient, serviceClient, USER_B_EMAIL);
  });

  afterAll(async () => {
    // Clean up test users and their data
    if (userAId) {
      await serviceClient.from('user_profiles').delete().eq('id', userAId);
      await serviceClient.auth.admin.deleteUser(userAId);
    }
    if (userBId) {
      await serviceClient.from('user_profiles').delete().eq('id', userBId);
      await serviceClient.auth.admin.deleteUser(userBId);
    }
  });

  // -------------------------------------------------------------------------
  // A1 – Run migrations in order
  // ⚠️  BLOCKED while the historical 001-004 SQL files remain absent from repo state
  // -------------------------------------------------------------------------

  (hasMigrationFiles ? test : test.skip)(
    'A1: all four migrations run in order without errors',
    async () => {
      for (const filename of MIGRATION_FILES) {
        const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
        const { error } = await serviceClient.rpc('exec_sql', { query: sql });
        expect(error).toBeNull();
      }
    }
  );

  // -------------------------------------------------------------------------
  // A2 – user_profiles schema
  // -------------------------------------------------------------------------

  test('A2: user_profiles upsert succeeds and returns expected column types', async () => {
    const { error } = await serviceClient.from('user_profiles').upsert({
      id: userAId,
      summary: 'Test summary',
      experience: [],
      skills_technical: [],
      skills_soft: [],
      education: [],
      certifications: [],
    });

    expect(error).toBeNull();

    const { data, error: selectError } = await serviceClient
      .from('user_profiles')
      .select('id, summary, experience, updated_at')
      .eq('id', userAId)
      .single();

    expect(selectError).toBeNull();
    expect(data.id).toBe(userAId);
    expect(typeof data.summary).toBe('string');
    expect(Array.isArray(data.experience)).toBe(true);
    expect(data.updated_at).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // A3 – updated_at trigger
  // -------------------------------------------------------------------------

  test('A3: updated_at is monotonically increasing after an update', async () => {
    // Ensure row exists
    await serviceClient.from('user_profiles').upsert({ id: userAId, summary: 'Initial' });
    const { data: d1 } = await serviceClient.from('user_profiles')
      .select('updated_at').eq('id', userAId).single();
    const t1 = new Date(d1.updated_at).getTime();

    await new Promise((r) => setTimeout(r, 20));

    await serviceClient.from('user_profiles').update({ summary: 'Updated' }).eq('id', userAId);
    const { data: d2 } = await serviceClient.from('user_profiles')
      .select('updated_at').eq('id', userAId).single();
    const t2 = new Date(d2.updated_at).getTime();

    expect(t2).toBeGreaterThan(t1);
  });

  // -------------------------------------------------------------------------
  // A4–A7 – user_profiles RLS
  // -------------------------------------------------------------------------

  test('A4: userA can select their own profile row', async () => {
    const { data, error } = await clientA.from('user_profiles')
      .select('id').eq('id', userAId).single();
    expect(error).toBeNull();
    expect(data.id).toBe(userAId);
  });

  test('A5: userA can update their own profile row', async () => {
    const { error } = await clientA.from('user_profiles')
      .update({ summary: 'UserA updated summary' }).eq('id', userAId);
    expect(error).toBeNull();
  });

  test('A6: userA cannot read userB profile row (empty result, not error)', async () => {
    // Ensure userB row exists
    await serviceClient.from('user_profiles').upsert({ id: userBId, summary: 'UserB row' });

    const { data, error } = await clientA.from('user_profiles')
      .select('id').eq('id', userBId);
    expect(error).toBeNull();
    // RLS returns empty array, not a 403
    expect(data).toHaveLength(0);
  });

  test('A7: userA cannot update userB profile row', async () => {
    const { error } = await clientA.from('user_profiles')
      .update({ summary: 'Hijacked by userA' }).eq('id', userBId);
    // RLS silently no-ops the update (0 rows affected) rather than throwing,
    // so we verify no data was changed
    expect(error).toBeNull();

    // Confirm userB's summary is unchanged
    const { data } = await serviceClient.from('user_profiles')
      .select('summary').eq('id', userBId).single();
    expect(data.summary).not.toBe('Hijacked by userA');
  });

  // -------------------------------------------------------------------------
  // A8–A9 – tailor_cache RLS
  // -------------------------------------------------------------------------

  test('A8: userA can insert and select their own tailor_cache row', async () => {
    const testHash = 'test-hash-' + userAId;

    const { error: insertError } = await clientA.from('tailor_cache').insert({
      user_id: userAId,
      cache_key: testHash,
      response: { summary: 'cached response' },
    });
    expect(insertError).toBeNull();

    const { data, error: selectError } = await clientA.from('tailor_cache')
      .select('cache_key').eq('user_id', userAId).eq('cache_key', testHash);
    expect(selectError).toBeNull();
    expect(data).toHaveLength(1);
  });

  test('A9: userB cannot read userA tailor_cache row', async () => {
    const testHash = 'test-hash-' + userAId;

    const { data, error } = await clientB.from('tailor_cache')
      .select('cache_key').eq('user_id', userAId).eq('cache_key', testHash);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // A10 – abuse_counters RLS (service-role only)
  // -------------------------------------------------------------------------

  test('A10: authenticated user sees zero abuse_counters rows (service-role only table)', async () => {
    const { data, error } = await clientA.from('abuse_counters').select('*');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // A11 – daily_spend RLS (service-role only)
  // -------------------------------------------------------------------------

  test('A11: authenticated user sees zero daily_spend rows (service-role only table)', async () => {
    const { data, error } = await clientA.from('daily_spend').select('*');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // A12 – daily_spend UTC date
  // -------------------------------------------------------------------------

  test('A12: daily_spend date column stores UTC date regardless of client timezone', async () => {
    const { error } = await serviceClient.from('daily_spend').insert({
      user_id: userAId,
      spend_date: new Date().toISOString().split('T')[0], // UTC date YYYY-MM-DD
      total_cost_usd: 0.01,
    });
    expect(error).toBeNull();

    const { data } = await serviceClient.from('daily_spend')
      .select('spend_date').eq('user_id', userAId).order('spend_date', { ascending: false }).limit(1);

    const storedDate = data[0].spend_date;
    const expectedUtcDate = new Date().toISOString().split('T')[0];
    expect(storedDate).toBe(expectedUtcDate);
  });
});
