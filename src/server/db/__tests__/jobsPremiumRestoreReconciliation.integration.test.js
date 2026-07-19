/**
 * Suite L - Premium restore migration reconciliation integration tests.
 *
 * Purpose: Reproduce an existing database with only migration 019's original
 * three-argument restore RPC, apply migration 028, and verify the hardened
 * four-argument PostgREST boundary and behavior.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  JOB_STORAGE_LOCK_POLICY_VERSION,
  JOB_STORAGE_LOCK_REASONS,
  JOB_STORAGE_STATES,
} from '../../../shared/constants/storage.js';
import { STORAGE_STATUSES } from '../../../shared/constants/billing.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const PREREQUISITE_MIGRATION_FILES = Object.freeze([
  '016_jobs_storage_state_boundary.sql',
  '017_jobs_atomic_create_quota.sql',
  '018_jobs_overflow_locking.sql',
]);
const PREMIUM_RESTORE_RECONCILIATION_MIGRATION_FILE =
  '028_reconcile_premium_restore_rpc.sql';
const TEST_PREMIUM_PRICE_IDS = Object.freeze(['price_premium_monthly']);

const {
  TEST_SUPABASE_ENV_NAMES,
  resolveDescribeOrSkip,
} = require('../../../testSupport/integrationEnvironment.js');

const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const { describeOrSkip } = resolveDescribeOrSkip(process.env, {
  suiteName: 'Suite L',
  requiredNames: [
    TEST_SUPABASE_ENV_NAMES.url,
    TEST_SUPABASE_ENV_NAMES.serviceKey,
  ],
}, describe);

// Recreate only the catalog shape that caused the live PGRST202 mismatch.
// Migration 028 and the behavior checks below prove the resulting function is
// the complete hardened implementation rather than this inert legacy fixture.
const LEGACY_RESTORE_FIXTURE_SQL = `
CREATE OR REPLACE FUNCTION public.restore_locked_jobs_for_premium_user(
  p_user_id uuid,
  p_storage_status text,
  p_absolute_retained_job_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $legacy_restore$
BEGIN
  RETURN jsonb_build_object(
    'applied', true,
    'restoredCount', 0,
    'legacyFixture', true
  );
END;
$legacy_restore$;

REVOKE ALL ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer)
  TO service_role;

DROP FUNCTION IF EXISTS public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[]);

DO $legacy_catalog$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.restore_locked_jobs_for_premium_user(uuid,text,integer)'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy Premium restore fixture did not reach the required catalog state';
  END IF;
END;
$legacy_catalog$;
`;

/**
 * Normalize exec_sql RPC data into a row array.
 *
 * Purpose: test-only SQL helpers can return native JSON, serialized JSON, or a
 * single row depending on the target project's helper definition.
 *
 * @param {unknown} data Raw public.exec_sql RPC response data.
 * @returns {object[]} Normalized row array.
 */
function normalizeExecSqlRows(data) {
  if (Array.isArray(data)) return data;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  return data && typeof data === 'object' ? [data] : [];
}

/**
 * Build searchable non-sensitive text from a Supabase error.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {string} Combined error text.
 */
function buildErrorMessage(error) {
  return `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''} ${error?.code ?? ''}`.trim();
}

/**
 * Detect a PostgREST schema-cache miss while SQL changes propagate.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {boolean} True when a short retry may observe the new function.
 */
function isRpcSchemaCacheError(error) {
  return /schema cache|could not find the function|PGRST/i.test(buildErrorMessage(error));
}

/**
 * Wait for a bounded PostgREST schema-cache propagation interval.
 *
 * @param {number} milliseconds Delay duration.
 * @returns {Promise<void>} Resolves after the delay.
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Normalize a JSON object returned by the Premium restore RPC.
 *
 * @param {unknown} data Raw RPC data.
 * @returns {object|null} Parsed object payload.
 */
function normalizeRestoreRpcData(data) {
  if (!data) return null;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  return typeof data === 'object' && !Array.isArray(data) ? data : null;
}

jest.setTimeout(60_000);

describeOrSkip('Suite L - Premium restore migration reconciliation integration', () => {
  let serviceClient;
  const cleanupUserIds = new Set();

  /**
   * Execute privileged SQL through the isolated test project's helper.
   *
   * Purpose: migration upgrade coverage must install a legacy catalog fixture
   * and migration 028 within one database transaction.
   *
   * @param {string} query SQL statement or migration body.
   * @returns {Promise<object[]>} Normalized result rows.
   */
  async function execSql(query) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('exec_sql', { query });

      if (!error) return normalizeExecSqlRows(data);

      lastError = error;
      const errorMessage = buildErrorMessage(error);

      if (/exec_sql/i.test(errorMessage) && isRpcSchemaCacheError(error)) {
        throw new Error(
          'Suite L requires a service-role-only public.exec_sql(query text) '
          + 'helper in the isolated integration database.'
        );
      }

      if (!isRpcSchemaCacheError(error)) throw error;
      await wait(250);
    }

    throw lastError;
  }

  /**
   * Apply the storage prerequisites needed by both restore signatures.
   *
   * Purpose: the reconciliation suite owns only the 019-to-028 transition and
   * should fail clearly when the base jobs or billing tables are absent.
   *
   * @returns {Promise<void>}
   */
  async function ensurePrerequisiteMigrationsApplied() {
    const tableRows = await execSql(`
      SELECT
        pg_catalog.to_regclass('public.jobs')::text AS jobs_table,
        pg_catalog.to_regclass('public.billing_customers')::text AS billing_customers_table,
        pg_catalog.to_regclass('public.billing_subscriptions')::text AS billing_subscriptions_table
    `);

    if (
      !tableRows[0]?.jobs_table
      || !tableRows[0]?.billing_customers_table
      || !tableRows[0]?.billing_subscriptions_table
    ) {
      throw new Error(
        'Suite L requires existing jobs, billing_customers, and billing_subscriptions tables.'
      );
    }

    for (const migrationFile of PREREQUISITE_MIGRATION_FILES) {
      const migrationPath = join(MIGRATIONS_DIR, migrationFile);
      if (!existsSync(migrationPath)) {
        throw new Error(`Missing migration fixture ${migrationFile}`);
      }

      await execSql(readFileSync(migrationPath, 'utf8'));
    }
  }

  /**
   * Install the legacy signature and migration 028 atomically.
   *
   * Purpose: reproduce the E2E schema mismatch without exposing the shared test
   * project to an intermediate broken state if reconciliation fails.
   *
   * @returns {Promise<void>}
   */
  async function installLegacySignatureAndReconcile() {
    const migrationPath = join(
      MIGRATIONS_DIR,
      PREMIUM_RESTORE_RECONCILIATION_MIGRATION_FILE
    );
    const migrationSql = readFileSync(migrationPath, 'utf8');

    await execSql(`${LEGACY_RESTORE_FIXTURE_SQL}\n${migrationSql}`);
    await wait(500);
  }

  /**
   * Read the reconciled restore-function catalog and privilege state.
   *
   * @returns {Promise<object>} Catalog row for the four-argument function.
   */
  async function getRestoreCatalogState() {
    const rows = await execSql(`
      SELECT
        pg_catalog.to_regprocedure(
          'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])'
        )::text AS required_signature,
        pg_catalog.to_regprocedure(
          'public.restore_locked_jobs_for_premium_user(uuid,text,integer)'
        )::text AS stale_signature,
        pg_catalog.has_function_privilege(
          'anon',
          'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])',
          'EXECUTE'
        ) AS anon_can_execute,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])',
          'EXECUTE'
        ) AS authenticated_can_execute,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])',
          'EXECUTE'
        ) AS service_role_can_execute,
        procedure_catalog.prosecdef,
        COALESCE(procedure_catalog.proconfig, ARRAY[]::text[]) AS proconfig
      FROM pg_catalog.pg_proc AS procedure_catalog
      WHERE procedure_catalog.oid = pg_catalog.to_regprocedure(
        'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])'
      )
    `);

    if (rows.length !== 1) {
      throw new Error('Reconciled Premium restore RPC catalog row is missing');
    }

    return rows[0];
  }

  /**
   * Create a disposable confirmed auth user for restore behavior checks.
   *
   * @param {string} prefix Unique email prefix.
   * @returns {Promise<{id: string, email: string}>} Created user identity.
   */
  async function createTempUser(prefix) {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      email_confirm: true,
    });

    if (error) throw error;
    if (!data?.user?.id) throw new Error(`createUser returned no id for ${email}`);

    cleanupUserIds.add(data.user.id);
    return { id: data.user.id, email };
  }

  /**
   * Seed canonical active billing rows for one disposable user.
   *
   * @param {string} userId User receiving the billing snapshot.
   * @param {string} priceId Subscription price identifier.
   * @returns {Promise<void>}
   */
  async function seedActiveSubscription(userId, priceId) {
    const uniqueSuffix = userId.replace(/-/g, '').slice(0, 20);
    const customerResult = await serviceClient.from('billing_customers').upsert({
      user_id: userId,
      stripe_customer_id: `cus_reconcile_${uniqueSuffix}`,
    });
    if (customerResult.error) throw customerResult.error;

    const subscriptionResult = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userId,
      stripe_subscription_id: `sub_reconcile_${uniqueSuffix}`,
      stripe_customer_id: `cus_reconcile_${uniqueSuffix}`,
      price_id: priceId,
      status: 'active',
      current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });
    if (subscriptionResult.error) throw subscriptionResult.error;
  }

  /**
   * Seed one locked archive row used by the allowlist negative check.
   *
   * @param {string} userId Row owner.
   * @returns {Promise<string>} Inserted job id.
   */
  async function seedLockedJob(userId) {
    const now = new Date().toISOString();
    const { data, error } = await serviceClient.from('jobs').insert({
      user_id: userId,
      company: `Reconciliation locked ${Date.now()}`,
      position: 'Premium Restore Reconciliation Engineer',
      status: 'applied',
      notes: '',
      salary_min: null,
      salary_max: null,
      status_date: now,
      storage_state: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
      locked_at: now,
      locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
      locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
    }).select('id').single();

    if (error) throw error;
    return data.id;
  }

  /**
   * Call the reconciled four-argument RPC through PostgREST.
   *
   * Purpose: verify schema-cache visibility as well as database behavior.
   *
   * @param {string} userId Restore target.
   * @returns {Promise<object>} Normalized restore result.
   */
  async function callPremiumRestoreRpc(userId) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('restore_locked_jobs_for_premium_user', {
        p_user_id: userId,
        p_storage_status: STORAGE_STATUSES.PREMIUM_ACTIVE,
        p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
        p_entitled_price_ids: TEST_PREMIUM_PRICE_IDS,
      });

      if (!error) return normalizeRestoreRpcData(data);

      lastError = error;
      if (!isRpcSchemaCacheError(error)) throw error;
      await wait(250);
    }

    throw lastError;
  }

  beforeAll(async () => {
    const { createClient } = await import('@supabase/supabase-js');
    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    await ensurePrerequisiteMigrationsApplied();
  });

  afterAll(async () => {
    if (!serviceClient) return;

    const userIds = [...cleanupUserIds];
    if (userIds.length > 0) {
      const jobsResult = await serviceClient.from('jobs').delete().in('user_id', userIds);
      if (jobsResult.error) throw jobsResult.error;

      const subscriptionsResult = await serviceClient
        .from('billing_subscriptions')
        .delete()
        .in('user_id', userIds);
      if (subscriptionsResult.error) throw subscriptionsResult.error;

      const customersResult = await serviceClient
        .from('billing_customers')
        .delete()
        .in('user_id', userIds);
      if (customersResult.error) throw customersResult.error;
    }

    for (const userId of userIds) {
      const { error } = await serviceClient.auth.admin.deleteUser(userId);
      if (error) throw error;
    }
  });

  test('L1: migration 028 upgrades a legacy-only restore signature atomically', async () => {
    expect(
      existsSync(join(MIGRATIONS_DIR, PREMIUM_RESTORE_RECONCILIATION_MIGRATION_FILE))
    ).toBe(true);

    await installLegacySignatureAndReconcile();

    await expect(getRestoreCatalogState()).resolves.toEqual(expect.objectContaining({
      required_signature: expect.stringMatching(
        /^(public\.)?restore_locked_jobs_for_premium_user\(uuid,text,integer,text\[\]\)$/
      ),
      stale_signature: null,
      anon_can_execute: false,
      authenticated_can_execute: false,
      service_role_can_execute: true,
      prosecdef: false,
      proconfig: expect.arrayContaining(['search_path=pg_catalog, public']),
    }));
  });

  test('L2: migration 028 is idempotent after reconciliation', async () => {
    const migrationSql = readFileSync(
      join(MIGRATIONS_DIR, PREMIUM_RESTORE_RECONCILIATION_MIGRATION_FILE),
      'utf8'
    );

    await execSql(migrationSql);
    await wait(500);

    await expect(getRestoreCatalogState()).resolves.toEqual(expect.objectContaining({
      required_signature: expect.stringMatching(
        /^(public\.)?restore_locked_jobs_for_premium_user\(uuid,text,integer,text\[\]\)$/
      ),
      stale_signature: null,
      anon_can_execute: false,
      authenticated_can_execute: false,
      service_role_can_execute: true,
    }));
  });

  test('L3: a new Premium account with no archive returns an idempotent zero-row result', async () => {
    const user = await createTempUser('restore-reconcile-new-premium');
    await seedActiveSubscription(user.id, TEST_PREMIUM_PRICE_IDS[0]);

    await expect(callPremiumRestoreRpc(user.id)).resolves.toEqual(expect.objectContaining({
      applied: true,
      restoredCount: 0,
      activeCountAfterRestore: 0,
      lockedCountAfterRestore: 0,
      retainedTotalCount: 0,
    }));
  });

  test('L4: the reconciled RPC retains the Premium price allowlist boundary', async () => {
    const user = await createTempUser('restore-reconcile-wrong-price');
    await seedActiveSubscription(user.id, 'price_not_entitled');
    const lockedJobId = await seedLockedJob(user.id);

    await expect(callPremiumRestoreRpc(user.id)).resolves.toEqual(expect.objectContaining({
      applied: false,
      reason: 'canonical_billing_not_premium',
      canonicalEntitlementReason: 'price_id_not_allowlisted',
      restoredCount: 0,
    }));

    const { data, error } = await serviceClient
      .from('jobs')
      .select('storage_state')
      .eq('id', lockedJobId)
      .single();

    if (error) throw error;
    expect(data.storage_state).toBe(JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT);
  });
});
