/**
 * Suite A - Canonical migration catalog + RLS integration tests
 *
 * Verifies the canonical Supabase baseline is recorded in the dedicated test
 * project, then exercises the Phase 0 tables and RLS policies without replaying
 * deployable migrations through the test-only exec_sql helper.
 *
 * Prerequisites (ALL required before this suite can run):
 *   1. Dedicated Supabase integration-test project
 *   2. Env vars: TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY,
 *                TEST_SUPABASE_ANON_KEY
 *   3. Canonical migrations under supabase/migrations already applied in order
 *   4. Restricted service-role-only public.exec_sql(query text) installed only
 *      after the canonical chain and authoritative baseline checks pass
 *   5. Two test user emails (SUPABASE_TEST_USER_A_EMAIL,
 *      SUPABASE_TEST_USER_B_EMAIL). The suite creates the auth users via the
 *      admin API and signs them in via admin-generated magic links - no
 *      passwords required (the project uses OAuth in normal use).
 *
 * Test structure:
 *   A1  - Canonical local files and remote migration catalog agree
 *   A2-A7  - user_profiles shape, trigger, and owner isolation
 *   A8-A9  - tailor_cache canonical shape and owner isolation
 *   A10-A11 - service-role-only table boundaries
 *   A12 - daily_spend canonical global-date shape and exact-date cleanup
 */

import { existsSync } from 'fs';
import { join } from 'path';

const SUPABASE_MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const CANONICAL_MIGRATIONS = Object.freeze([
  {
    filename: '20260713000000_authoritative_preproduction_baseline.sql',
    version: '20260713000000',
  },
  {
    filename: '20260713000100_reconcile_preproduction_schema_drift.sql',
    version: '20260713000100',
  },
]);

const {
  TEST_SUPABASE_ENV_NAMES,
  resolveDestructiveIntegrationEnvironment,
} = require('../../../testSupport/integrationEnvironment.js');
const {
  runIntegrationCleanup,
} = require('../../../testSupport/integrationCleanup.js');

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

  const dailySpendTestDate = new Date().toISOString().split('T')[0];

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
    if (!serviceClient) return;

    const userIds = [userAId, userBId].filter(Boolean);
    await runIntegrationCleanup([
      {
        label: 'daily spend test date',
        cleanup: () => serviceClient
          .from('daily_spend')
          .delete()
          .eq('date', dailySpendTestDate),
      },
      ...(userIds.length > 0
        ? [
            {
              label: 'tailor cache rows',
              cleanup: () => serviceClient
                .from('tailor_cache')
                .delete()
                .in('user_id', userIds),
            },
            {
              label: 'profile rows',
              cleanup: () => serviceClient
                .from('user_profiles')
                .delete()
                .in('user_id', userIds),
            },
          ]
        : []),
      ...userIds.map((userId) => ({
        label: `migration-suite auth user ${userId === userAId ? 'A' : 'B'}`,
        cleanup: () => serviceClient.auth.admin.deleteUser(userId),
      })),
    ]);
  });

  // -------------------------------------------------------------------------
  // A1 - Verify the canonical local chain against the applied remote catalog.
  // -------------------------------------------------------------------------

  test('A1: canonical Supabase migration files match the remote catalog', async () => {
    for (const migration of CANONICAL_MIGRATIONS) {
      expect(existsSync(join(SUPABASE_MIGRATIONS_DIR, migration.filename))).toBe(true);
    }

    const { data, error } = await serviceClient.rpc('exec_sql', {
      query: `
        SELECT version::text AS version
        FROM supabase_migrations.schema_migrations
        ORDER BY version
      `,
    });

    expect(error).toBeNull();
    expect(data).toEqual(CANONICAL_MIGRATIONS.map(({ version }) => ({ version })));
  });

  // -------------------------------------------------------------------------
  // A2 – user_profiles schema
  // -------------------------------------------------------------------------

  test('A2: user_profiles upsert succeeds and returns expected column types', async () => {
    const { error } = await serviceClient.from('user_profiles').upsert({
      user_id: userAId,
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
      .select('user_id, summary, experience, updated_at')
      .eq('user_id', userAId)
      .single();

    expect(selectError).toBeNull();
    expect(data.user_id).toBe(userAId);
    expect(typeof data.summary).toBe('string');
    expect(Array.isArray(data.experience)).toBe(true);
    expect(data.updated_at).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // A3 – updated_at trigger
  // -------------------------------------------------------------------------

  test('A3: updated_at is monotonically increasing after an update', async () => {
    // Ensure row exists
    await serviceClient.from('user_profiles').upsert({ user_id: userAId, summary: 'Initial' });
    const { data: d1 } = await serviceClient.from('user_profiles')
      .select('updated_at').eq('user_id', userAId).single();
    const t1 = new Date(d1.updated_at).getTime();

    await new Promise((r) => setTimeout(r, 20));

    await serviceClient.from('user_profiles').update({ summary: 'Updated' }).eq('user_id', userAId);
    const { data: d2 } = await serviceClient.from('user_profiles')
      .select('updated_at').eq('user_id', userAId).single();
    const t2 = new Date(d2.updated_at).getTime();

    expect(t2).toBeGreaterThan(t1);
  });

  // -------------------------------------------------------------------------
  // A4–A7 – user_profiles RLS
  // -------------------------------------------------------------------------

  test('A4: userA can select their own profile row', async () => {
    const { data, error } = await clientA.from('user_profiles')
      .select('user_id').eq('user_id', userAId).single();
    expect(error).toBeNull();
    expect(data.user_id).toBe(userAId);
  });

  test('A5: userA can update their own profile row', async () => {
    const { error } = await clientA.from('user_profiles')
      .update({ summary: 'UserA updated summary' }).eq('user_id', userAId);
    expect(error).toBeNull();
  });

  test('A6: userA cannot read userB profile row (empty result, not error)', async () => {
    // Ensure userB row exists
    await serviceClient.from('user_profiles').upsert({ user_id: userBId, summary: 'UserB row' });

    const { data, error } = await clientA.from('user_profiles')
      .select('user_id').eq('user_id', userBId);
    expect(error).toBeNull();
    // RLS returns empty array, not a 403
    expect(data).toHaveLength(0);
  });

  test('A7: userA cannot update userB profile row', async () => {
    const { error } = await clientA.from('user_profiles')
      .update({ summary: 'Hijacked by userA' }).eq('user_id', userBId);
    // RLS silently no-ops the update (0 rows affected) rather than throwing,
    // so we verify no data was changed
    expect(error).toBeNull();

    // Confirm userB's summary is unchanged
    const { data } = await serviceClient.from('user_profiles')
      .select('summary').eq('user_id', userBId).single();
    expect(data.summary).not.toBe('Hijacked by userA');
  });

  // -------------------------------------------------------------------------
  // A8–A9 – tailor_cache RLS
  // -------------------------------------------------------------------------

  test('A8: userA can insert and select their own tailor_cache row', async () => {
    const testHash = 'test-hash-' + userAId;
    const createdAt = new Date().toISOString();

    const { error: insertError } = await clientA.from('tailor_cache').insert({
      hash: testHash,
      user_id: userAId,
      response: { summary: 'cached response' },
      created_at: createdAt,
    });
    expect(insertError).toBeNull();

    const { data, error: selectError } = await clientA.from('tailor_cache')
      .select('hash, user_id, response, created_at')
      .eq('user_id', userAId)
      .eq('hash', testHash);
    expect(selectError).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual(expect.objectContaining({
      hash: testHash,
      user_id: userAId,
      response: { summary: 'cached response' },
    }));
    expect(new Date(data[0].created_at).toISOString()).toBe(createdAt);
  });

  test('A9: userB cannot read userA tailor_cache row', async () => {
    const testHash = 'test-hash-' + userAId;

    const { data, error } = await clientB.from('tailor_cache')
      .select('hash').eq('user_id', userAId).eq('hash', testHash);
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
    await runIntegrationCleanup([
      {
        label: 'daily spend test date',
        cleanup: () => serviceClient
          .from('daily_spend')
          .delete()
          .eq('date', dailySpendTestDate),
      },
    ]);

    const { error } = await serviceClient.from('daily_spend').insert({
      date: dailySpendTestDate,
      total_cost_cents: 1,
    });
    expect(error).toBeNull();

    const { data, error: selectError } = await serviceClient
      .from('daily_spend')
      .select('date, total_cost_cents')
      .eq('date', dailySpendTestDate)
      .single();

    expect(selectError).toBeNull();
    expect(data).toEqual({
      date: dailySpendTestDate,
      total_cost_cents: 1,
    });
  });
});
