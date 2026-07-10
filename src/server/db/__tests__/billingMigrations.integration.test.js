/**
 * Suite B - Billing migration + RLS integration tests
 *
 * Session-only companion suite for the Phase 2 billing schema drafts stored in
 * the repo-root gitignored migrations/ folder:
 *   - 005_billing_customers.sql
 *   - 006_billing_subscriptions.sql
 *   - 007_stripe_event_receipts.sql
 *   - 008_billing_subscriptions_customer_fk.sql
 *   - 009_billing_subscriptions_status_changed_at_trigger.sql
 *   - 010_billing_subscriptions_remove_trialing_status.sql
 *   - 011_billing_concurrency_guards.sql
 *   - 012_billing_customer_email_fingerprint.sql
 *   - 013_billing_checkout_sessions.sql
 *   - 014_billing_checkout_premium_plan_rename.sql
 *   - 015_fix_billing_subscription_event_rpc_ambiguity.sql
 *   - 026_require_authoritative_billing_snapshot.sql
 *
 * Notes:
 *   1. This suite may apply 005-015 plus additive migration 026 when the billing tables are absent, or
 *      apply additive follow-ups alone when the base tables exist without the
 *      follow-up migrations.
 *   2. That is not the same as a full fresh-schema replay for the project.
 *      The earlier 001-004 migrations are not stored in the repo under the
 *      current local-only policy, so end-to-end replay from repo state remains
 *      unavailable.
 *   3. The suite uses a real Supabase integration environment and requires the
 *      service-role-only public.exec_sql(query text) RPC already assumed by the
 *      existing migration harness. If that helper is absent, the suite fails
 *      with a setup error before treating SQL semantics as covered.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

const TEST_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const TEST_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const RUN_DESTRUCTIVE_DB_INTEGRATION = process.env.RUN_DESTRUCTIVE_DB_INTEGRATION === 'true';
const SUPABASE_TEST_PROJECT_REF = process.env.SUPABASE_TEST_PROJECT_REF;
const EXPECTED_TEST_URL_PREFIX = SUPABASE_TEST_PROJECT_REF
  ? `https://${SUPABASE_TEST_PROJECT_REF}.supabase.co`
  : '';

const isExpectedSupabaseTarget = Boolean(
  TEST_URL
  && EXPECTED_TEST_URL_PREFIX
  && (
    TEST_URL === EXPECTED_TEST_URL_PREFIX
    || TEST_URL.startsWith(`${EXPECTED_TEST_URL_PREFIX}/`)
  )
);

const USER_A_EMAIL = process.env.SUPABASE_TEST_USER_A_EMAIL;
const USER_B_EMAIL = process.env.SUPABASE_TEST_USER_B_EMAIL;

const BILLING_MIGRATION_FILES = [
  '005_billing_customers.sql',
  '006_billing_subscriptions.sql',
  '007_stripe_event_receipts.sql',
  '008_billing_subscriptions_customer_fk.sql',
  '009_billing_subscriptions_status_changed_at_trigger.sql',
  '010_billing_subscriptions_remove_trialing_status.sql',
  '011_billing_concurrency_guards.sql',
  '012_billing_customer_email_fingerprint.sql',
  '013_billing_checkout_sessions.sql',
  '014_billing_checkout_premium_plan_rename.sql',
  '015_fix_billing_subscription_event_rpc_ambiguity.sql',
  '026_require_authoritative_billing_snapshot.sql',
];

const BASE_BILLING_TABLE_NAMES = [
  'billing_customers',
  'billing_subscriptions',
  'stripe_event_receipts',
];
const ALL_BILLING_TABLE_NAMES = [
  ...BASE_BILLING_TABLE_NAMES,
  'billing_checkout_sessions',
];

const BILLING_SUBSCRIPTIONS_CUSTOMER_FK =
  'billing_subscriptions_billing_customers_user_id_fkey';
const BILLING_CUSTOMERS_EMAIL_FINGERPRINT_COLUMN =
  'last_synced_stripe_email_fingerprint';
const BILLING_CUSTOMERS_EMAIL_FINGERPRINT_FORMAT_PATTERN =
  /\^\[0-9a-f\]\{64\}\$/i;

const BILLING_STATUS_CHANGED_AT_FUNCTION =
  'touch_billing_status_changed_at';

const BILLING_STATUS_CHANGED_AT_TRIGGER =
  'set_billing_subscriptions_status_changed_at';

const BILLING_SUBSCRIPTIONS_STATUS_CHECK =
  'billing_subscriptions_status_check';

const BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION =
  'upsert_billing_subscription_if_newer_or_equal';

const BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION =
  'upsert_billing_subscription_authoritative';
const BILLING_SUBSCRIPTION_SNAPSHOT_VERSION_FUNCTION =
  'advance_billing_subscription_snapshot_version';
const BILLING_SUBSCRIPTION_SNAPSHOT_VERSION_TRIGGER =
  'advance_billing_subscription_snapshot_version';
const BILLING_SUBSCRIPTION_SNAPSHOT_VERSION_CONSTRAINT =
  'billing_subscriptions_snapshot_version_check';

const STRIPE_EVENT_RECEIPT_MERGE_FUNCTION =
  'merge_stripe_event_receipt';
const BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION =
  'claim_billing_checkout_session';
const BILLING_CHECKOUT_SESSION_PLAN_ALLOWED_CONSTRAINT =
  'billing_checkout_sessions_plan_allowed_check';

const BILLING_RPC_FUNCTIONS = [
  BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION,
  BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
  STRIPE_EVENT_RECEIPT_MERGE_FUNCTION,
];

const ADDITIVE_BILLING_MIGRATIONS = [
  {
    filename: '008_billing_subscriptions_customer_fk.sql',
    isApplied: (shape) => shape.constraints.has(BILLING_SUBSCRIPTIONS_CUSTOMER_FK),
  },
  {
    filename: '009_billing_subscriptions_status_changed_at_trigger.sql',
    isApplied: (shape) => (
      shape.functions.has(BILLING_STATUS_CHANGED_AT_FUNCTION)
      && shape.triggers.has(BILLING_STATUS_CHANGED_AT_TRIGGER)
    ),
  },
  {
    filename: '010_billing_subscriptions_remove_trialing_status.sql',
    isApplied: (shape) => {
      const definition = shape.constraintDefinitions.get(BILLING_SUBSCRIPTIONS_STATUS_CHECK) ?? '';
      return !/trialing/i.test(definition);
    },
  },
  {
    filename: '011_billing_concurrency_guards.sql',
    isApplied: (shape) => (
      BILLING_RPC_FUNCTIONS.every((functionName) => shape.functions.has(functionName))
    ),
  },
  {
    filename: '012_billing_customer_email_fingerprint.sql',
    isApplied: hasBillingCustomerEmailFingerprintConstraint,
  },
  {
    filename: '013_billing_checkout_sessions.sql',
    isApplied: (shape) => (
      shape.tables.has('billing_checkout_sessions')
      && shape.functions.has(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION)
    ),
  },
  {
    filename: '014_billing_checkout_premium_plan_rename.sql',
    isApplied: isPremiumCheckoutPlanRenameApplied,
  },
  {
    filename: '015_fix_billing_subscription_event_rpc_ambiguity.sql',
    isApplied: isBillingSubscriptionEventRpcAmbiguityFixApplied,
  },
  {
    filename: '026_require_authoritative_billing_snapshot.sql',
    isApplied: isAuthoritativeSubscriptionSnapshotGuardApplied,
  },
];

const hasInfra = Boolean(
  RUN_DESTRUCTIVE_DB_INTEGRATION
  && isExpectedSupabaseTarget
  && TEST_URL
  && TEST_SERVICE_KEY
  && TEST_ANON_KEY
  && USER_A_EMAIL
  && USER_B_EMAIL
);

if (RUN_DESTRUCTIVE_DB_INTEGRATION && !isExpectedSupabaseTarget) {
  throw new Error(
    'Refusing to run Suite B: NEXT_PUBLIC_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
  );
}

/**
 * Normalize exec_sql RPC payloads into row arrays.
 *
 * Purpose: the test-only SQL helper may return arrays, JSON strings, { rows },
 * or a single object depending on database/helper shape.
 *
 * @param {unknown} data raw serviceClient.rpc('exec_sql') data.
 * @returns {object[]} normalized result rows; no side effects.
 */
function normalizeExecSqlRows(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return normalizeExecSqlRows(parsed);
    } catch {
      return [];
    }
  }

  if (data && Array.isArray(data.rows)) {
    return data.rows;
  }

  if (data && typeof data === 'object') {
    return [data];
  }

  return [];
}

/**
 * Normalize billing RPC payloads that may be returned as JSON strings.
 *
 * Purpose: PostgREST/RPC responses can encode structured function results as
 * text, so tests parse JSON when possible while preserving scalar values.
 *
 * @param {unknown} data raw RPC data from callBillingRpc.
 * @returns {unknown} parsed JSON when valid, otherwise the original value.
 */
function normalizeRpcResult(data) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  return data;
}

function buildPermissionMessage(error) {
  return `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''} ${error?.code ?? ''}`.trim();
}

function expectPermissionError(error) {
  expect(error).toBeTruthy();
  expect(buildPermissionMessage(error)).toMatch(/permission|forbidden|not allowed|insufficient|42501/i);
}

function expectZeroRowsOrPermission(result) {
  if (result.error) {
    expectPermissionError(result.error);
    return;
  }

  expect(Array.isArray(result.data)).toBe(true);
  expect(result.data).toHaveLength(0);
}

function expectPermissionOrNullData(result) {
  if (result.error) {
    expectPermissionError(result.error);
    return;
  }

  expect(result.data === null || (Array.isArray(result.data) && result.data.length === 0)).toBe(true);
}

/**
 * Check whether the installed Checkout claim boundary uses premium plan names.
 *
 * Purpose: already-applied integration databases can have the 013 table/RPC
 * shape while still enforcing the old resume-tailor plan value, so additive
 * setup must inspect definitions instead of only checking object existence.
 *
 * @param {object} shape installed billing schema shape from introspection.
 * @returns {boolean}
 */
function isPremiumCheckoutPlanRenameApplied(shape) {
  const constraintDefinition =
    shape.constraintDefinitions.get(BILLING_CHECKOUT_SESSION_PLAN_ALLOWED_CONSTRAINT) ?? '';
  const functionDefinition =
    shape.functionDefinitions.get(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION) ?? '';

  return constraintDefinition.includes('premium_monthly')
    && !/resume_tailor_monthly/i.test(constraintDefinition)
    && functionDefinition.includes('premium_monthly')
    && !/resume_tailor_monthly/i.test(functionDefinition);
}

/**
 * Check whether the installed customer email fingerprint guard exists.
 *
 * Purpose: Postgres truncates identifiers beyond 63 bytes, so the migration
 * detector must validate the durable CHECK definition instead of the overlong
 * source constraint name from 012.
 *
 * @param {object} shape installed billing schema shape from introspection.
 * @returns {boolean}
 */
function hasBillingCustomerEmailFingerprintConstraint(shape) {
  return [...shape.constraintDefinitions.values()].some((definition) => (
    definition.includes(BILLING_CUSTOMERS_EMAIL_FINGERPRINT_COLUMN)
    && BILLING_CUSTOMERS_EMAIL_FINGERPRINT_FORMAT_PATTERN.test(definition)
  ));
}

/**
 * Check whether the installed event upsert RPC has the ambiguity fix.
 *
 * Purpose: databases can already have the 011 RPC installed while still
 * carrying the broken body, so additive migration setup must inspect the
 * function definition instead of checking only for RPC existence.
 *
 * @param {object} shape installed billing schema shape from introspection.
 * @returns {boolean}
 */
function isBillingSubscriptionEventRpcAmbiguityFixApplied(shape) {
  const functionDefinition =
    shape.functionDefinitions.get(BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION) ?? '';

  return /v_applied\s+boolean/i.test(functionDefinition)
    && /result_applied/i.test(functionDefinition)
    && !/\bapplied\s+boolean\s*;/i.test(functionDefinition)
    && !/INTO\s+applied\s*,\s*subscription\s*,\s*reason/i.test(functionDefinition);
}

/**
 * Check whether the authoritative RPC requires the versioned snapshot contract.
 *
 * Purpose: function existence alone can describe the older optional timestamp
 * guard, so additive setup inspects the durable function body for the mandatory
 * existence marker, monotonic version, and purpose discriminator.
 *
 * @param {object} shape installed billing schema shape from introspection.
 * @returns {boolean}
 */
function isAuthoritativeSubscriptionSnapshotGuardApplied(shape) {
  const functionDefinition =
    shape.functionDefinitions.get(BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION) ?? '';

  return functionDefinition.includes('_expected_subscription_exists')
    && functionDefinition.includes('_expected_subscription_snapshot_version')
    && functionDefinition.includes('_authoritative_sync_purpose')
    && functionDefinition.includes('subscription_replacement_blocked');
}

function isRpcSchemaCacheError(error) {
  return /schema cache|could not find the function|PGRST/i.test(buildPermissionMessage(error));
}

/**
 * Detect a missing exec_sql migration helper in the integration database.
 *
 * Purpose: the billing migration suite depends on a privileged test-only SQL
 * executor, so a missing helper should fail with setup guidance instead of
 * retrying as if PostgREST only needed a schema-cache refresh.
 *
 * @param {object | null | undefined} error
 * @returns {boolean}
 */
function isExecSqlHelperMissingError(error) {
  const message = buildPermissionMessage(error);
  return /exec_sql/i.test(message)
    && /schema cache|could not find the function|PGRST/i.test(message);
}

/**
 * Sign in an integration test user with a Supabase magic-link token.
 *
 * Purpose: RLS assertions need real anon clients authenticated as seeded users,
 * while setup still uses admin auth to mint the test login link.
 *
 * @param {Function} createClient Supabase client factory.
 * @param {object} adminClient service-role client with auth.admin access.
 * @param {string} email test user email to authenticate.
 * @returns {Promise<object>} authenticated anon Supabase client.
 * Side effects/connections: calls admin auth generateLink and verifyOtp against
 * TEST_URL/TEST_ANON_KEY without persisting a browser session.
 */
async function signInAsUser(createClient, adminClient, email) {
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError) throw linkError;

  const tokenHash = linkData?.properties?.hashed_token;
  if (!tokenHash) {
    throw new Error(`generateLink returned no hashed_token for ${email}`);
  }

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

jest.setTimeout(30_000);

describeOrSkip('Suite B - Billing migration + RLS integration', () => {
  let serviceClient;
  let anonClient;
  let clientA;
  let clientB;
  let userAId;
  let userBId;
  let billingRpcSchemaPrimed = false;

  const cleanupEventIds = new Set();
  const cleanupUserIds = new Set();

  /**
   * Execute privileged SQL through the test-only exec_sql RPC.
   *
   * Purpose: migration setup and schema assertions need service-role SQL access
   * while keeping helper result shapes normalized for callers.
   *
   * @param {string} query SQL statement or migration body to run.
   * @returns {Promise<object[]>} normalized row array from normalizeExecSqlRows().
   * Side effects/connections: uses serviceClient.rpc('exec_sql'), retries
   * PostgREST schema-cache lag, waits between retries, and throws setup
   * guidance when the helper RPC is missing.
   */
  async function execSql(query) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('exec_sql', { query });

      if (!error) {
        return normalizeExecSqlRows(data);
      }

      lastError = error;

      if (isExecSqlHelperMissingError(error)) {
        throw new Error(
          'Billing migration integration tests require a service-role-only '
          + 'public.exec_sql(query text) RPC helper in the target test database.'
        );
      }

      if (!isRpcSchemaCacheError(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw lastError;
  }

  async function reloadPostgrestSchema() {
    await execSql(`notify pgrst, 'reload schema';`);
    billingRpcSchemaPrimed = false;
  }

  async function callBillingRpc(client, fn, args, { retryOnSchemaLag = false } = {}) {
    const attemptRpc = async () => client.rpc(fn, args);

    if (!retryOnSchemaLag) {
      const result = await attemptRpc();
      result.data = normalizeRpcResult(result.data);
      return result;
    }

    let lastResult = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      lastResult = await attemptRpc();
      lastResult.data = normalizeRpcResult(lastResult.data);

      if (!lastResult.error || !isRpcSchemaCacheError(lastResult.error)) {
        if (!lastResult.error) {
          billingRpcSchemaPrimed = true;
        }
        return lastResult;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return lastResult;
  }

  async function callServiceBillingRpc(fn, args) {
    return callBillingRpc(serviceClient, fn, args, {
      retryOnSchemaLag: !billingRpcSchemaPrimed,
    });
  }

  async function getBillingTableState() {
    const rows = await execSql(`
      SELECT
        pg_catalog.to_regclass('public.billing_customers')::text AS billing_customers,
        pg_catalog.to_regclass('public.billing_subscriptions')::text AS billing_subscriptions,
        pg_catalog.to_regclass('public.stripe_event_receipts')::text AS stripe_event_receipts,
        pg_catalog.to_regclass('public.billing_checkout_sessions')::text AS billing_checkout_sessions
    `);

    return rows[0] ?? {};
  }

  async function getInstalledBillingShape() {
    const [tableRows, functionRows, triggerRows, policyRows, indexRows, constraintRows] = await Promise.all([
      execSql(`
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (
            'billing_customers',
            'billing_subscriptions',
            'stripe_event_receipts',
            'billing_checkout_sessions'
          )
      `),
      execSql(`
        SELECT
          proname,
          coalesce(proconfig, ARRAY[]::text[]) AS proconfig,
          prosecdef,
          pg_catalog.pg_get_functiondef(oid) AS function_definition
        FROM pg_catalog.pg_proc
        WHERE pronamespace = 'public'::pg_catalog.regnamespace
          AND proname IN (
            'touch_billing_updated_at',
            '${BILLING_STATUS_CHANGED_AT_FUNCTION}',
            '${BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION}',
            '${BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION}',
            '${BILLING_SUBSCRIPTION_SNAPSHOT_VERSION_FUNCTION}',
            '${STRIPE_EVENT_RECEIPT_MERGE_FUNCTION}',
            '${BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION}'
          )
      `),
      execSql(`
        SELECT tgname
        FROM pg_catalog.pg_trigger
        WHERE tgrelid IN (
          SELECT cls.oid
          FROM pg_catalog.pg_class cls
          JOIN pg_catalog.pg_namespace ns
            ON ns.oid = cls.relnamespace
          WHERE ns.nspname = 'public'
            AND cls.relname IN (
              'billing_customers',
              'billing_subscriptions',
              'billing_checkout_sessions'
            )
        )
          AND NOT tgisinternal
      `),
      execSql(`
        SELECT tablename, policyname
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND tablename IN (
            'billing_customers',
            'billing_subscriptions',
            'stripe_event_receipts',
            'billing_checkout_sessions'
          )
      `),
      execSql(`
        SELECT tablename, indexname
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN (
            'billing_customers',
            'billing_subscriptions',
            'stripe_event_receipts',
            'billing_checkout_sessions'
          )
      `),
      execSql(`
        SELECT
          cls.relname AS table_name,
          con.conname AS constraint_name,
          pg_catalog.pg_get_constraintdef(con.oid, true) AS constraint_definition
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class cls
          ON cls.oid = con.conrelid
        JOIN pg_catalog.pg_namespace ns
          ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public'
          AND cls.relname IN (
            'billing_customers',
            'billing_subscriptions',
            'stripe_event_receipts',
            'billing_checkout_sessions'
          )
      `),
    ]);

    return {
      tables: new Set(tableRows.map((row) => row.tablename)),
      functions: new Set(functionRows.map((row) => row.proname)),
      functionConfigs: new Map(functionRows.map((row) => [row.proname, row.proconfig ?? []])),
      functionSecurity: new Map(functionRows.map((row) => [row.proname, row.prosecdef])),
      functionDefinitions: new Map(
        functionRows.map((row) => [row.proname, row.function_definition || ''])
      ),
      triggers: new Set(triggerRows.map((row) => row.tgname)),
      policies: policyRows,
      indexes: new Set(indexRows.map((row) => row.indexname)),
      constraints: new Set(constraintRows.map((row) => row.constraint_name)),
      constraintDefinitions: new Map(
        constraintRows.map((row) => [row.constraint_name, row.constraint_definition || ''])
      ),
    };
  }

  function assertInstalledBillingShape(shape) {
    const expectedTriggerNames = [
      'set_billing_customers_updated_at',
      BILLING_STATUS_CHANGED_AT_TRIGGER,
      'set_billing_subscriptions_updated_at',
      BILLING_SUBSCRIPTION_SNAPSHOT_VERSION_TRIGGER,
      'set_billing_checkout_sessions_updated_at',
    ];

    const expectedFunctionNames = [
      'touch_billing_updated_at',
      BILLING_STATUS_CHANGED_AT_FUNCTION,
      ...BILLING_RPC_FUNCTIONS,
      BILLING_SUBSCRIPTION_SNAPSHOT_VERSION_FUNCTION,
      BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION,
    ];

    const expectedPolicyPairs = [
      ['billing_customers', 'billing_customers_select_own'],
      ['billing_subscriptions', 'billing_subscriptions_select_own'],
    ];

    const expectedIndexNames = [
      'billing_customers_pkey',
      'billing_customers_stripe_customer_id_unique_idx',
      'billing_subscriptions_pkey',
      'billing_subscriptions_stripe_subscription_id_key',
      'billing_checkout_sessions_pkey',
      'billing_checkout_sessions_active_user_plan_idx',
      'billing_checkout_sessions_stripe_session_id_unique_idx',
      'billing_checkout_sessions_user_session_idx',
      'stripe_event_receipts_pkey',
      'stripe_event_receipts_processed_at_idx',
    ];

    const expectedConstraintNames = [
      'billing_customers_pkey',
      'billing_customers_stripe_customer_id_format_check',
      'billing_customers_user_id_fkey',
      'billing_subscriptions_pkey',
      BILLING_SUBSCRIPTIONS_CUSTOMER_FK,
      'billing_subscriptions_status_check',
      'billing_subscriptions_stripe_subscription_id_format_check',
      'billing_subscriptions_stripe_customer_id_format_check',
      'billing_subscriptions_user_id_fkey',
      'billing_subscriptions_stripe_subscription_id_key',
      BILLING_SUBSCRIPTION_SNAPSHOT_VERSION_CONSTRAINT,
      'stripe_event_receipts_pkey',
      'stripe_event_receipts_event_id_format_check',
      'stripe_event_receipts_result_check',
      'stripe_event_receipts_event_type_length_check',
      'billing_checkout_sessions_pkey',
      'billing_checkout_sessions_plan_format_check',
      BILLING_CHECKOUT_SESSION_PLAN_ALLOWED_CONSTRAINT,
      'billing_checkout_sessions_status_check',
      'billing_checkout_sessions_stripe_session_id_format_check',
      'billing_checkout_sessions_open_fields_check',
      'billing_checkout_sessions_user_id_fkey',
    ];

    for (const tableName of ALL_BILLING_TABLE_NAMES) {
      expect(shape.tables.has(tableName)).toBe(true);
    }

    for (const functionName of expectedFunctionNames) {
      expect(shape.functions.has(functionName)).toBe(true);
    }

    for (const triggerName of expectedTriggerNames) {
      expect(shape.triggers.has(triggerName)).toBe(true);
    }

    const policyPairs = shape.policies.map((row) => [row.tablename, row.policyname]);
    expect(policyPairs).toEqual(expect.arrayContaining(expectedPolicyPairs));

    const stripePolicies = shape.policies.filter((row) => row.tablename === 'stripe_event_receipts');
    expect(stripePolicies).toHaveLength(0);

    const checkoutPolicies = shape.policies.filter((row) => row.tablename === 'billing_checkout_sessions');
    expect(checkoutPolicies).toHaveLength(0);

    for (const indexName of expectedIndexNames) {
      expect(shape.indexes.has(indexName)).toBe(true);
    }

    for (const constraintName of expectedConstraintNames) {
      expect(shape.constraints.has(constraintName)).toBe(true);
    }

    expect(hasBillingCustomerEmailFingerprintConstraint(shape)).toBe(true);

    const statusConstraintDefinition =
      shape.constraintDefinitions.get(BILLING_SUBSCRIPTIONS_STATUS_CHECK) ?? '';
    expect(statusConstraintDefinition).toContain('active');
    expect(statusConstraintDefinition).not.toMatch(/trialing/i);

    const checkoutPlanConstraintDefinition =
      shape.constraintDefinitions.get(BILLING_CHECKOUT_SESSION_PLAN_ALLOWED_CONSTRAINT) ?? '';
    expect(checkoutPlanConstraintDefinition).toContain('premium_monthly');
    expect(checkoutPlanConstraintDefinition).not.toMatch(/resume_tailor_monthly/i);

    const checkoutClaimFunctionDefinition =
      shape.functionDefinitions.get(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION) ?? '';
    expect(checkoutClaimFunctionDefinition).toContain('premium_monthly');
    expect(checkoutClaimFunctionDefinition).not.toMatch(/resume_tailor_monthly/i);

    expect(isBillingSubscriptionEventRpcAmbiguityFixApplied(shape)).toBe(true);
    expect(isAuthoritativeSubscriptionSnapshotGuardApplied(shape)).toBe(true);
  }

  /**
   * Ensure the billing migration set required by this suite is installed.
   *
   * Purpose: the integration database may already have base tables, so setup
   * applies only missing additive migrations or performs a full base apply plus
   * the reserved authoritative snapshot migration.
   *
   * @returns {Promise<void>}
   * Important vars: existingBaseTables gates partial-schema errors,
   * missingAdditiveMigrations drives targeted applies, and appliedRpcMigration
   * decides whether PostgREST schema reload is needed.
   * Side effects/connections: reads migration SQL files, calls
   * serviceClient.rpc('exec_sql'), reloads schema for RPC migrations, and
   * asserts the installed billing shape.
   */
  async function ensureBillingMigrationsApplied() {
    const tableState = await getBillingTableState();
    const existingBaseTables = [
      tableState.billing_customers,
      tableState.billing_subscriptions,
      tableState.stripe_event_receipts,
    ].filter(Boolean);

    if (existingBaseTables.length === BASE_BILLING_TABLE_NAMES.length) {
      const installedShape = await getInstalledBillingShape();
      const missingAdditiveMigrations = ADDITIVE_BILLING_MIGRATIONS.filter(
        (migration) => !migration.isApplied(installedShape)
      );

      if (missingAdditiveMigrations.length > 0) {
        let appliedRpcMigration = false;

        for (const migration of missingAdditiveMigrations) {
          const sql = readFileSync(
            join(MIGRATIONS_DIR, migration.filename),
            'utf8'
          );
          const { error } = await serviceClient.rpc('exec_sql', { query: sql });
          expect(error).toBeNull();

          if (
            migration.filename === '011_billing_concurrency_guards.sql'
            || migration.filename === '013_billing_checkout_sessions.sql'
            || migration.filename === '014_billing_checkout_premium_plan_rename.sql'
            || migration.filename === '015_fix_billing_subscription_event_rpc_ambiguity.sql'
            || migration.filename === '026_require_authoritative_billing_snapshot.sql'
          ) {
            appliedRpcMigration = true;
          }
        }

        if (appliedRpcMigration) {
          await reloadPostgrestSchema();
        }

        const updatedShape = await getInstalledBillingShape();
        assertInstalledBillingShape(updatedShape);
        return;
      }

      assertInstalledBillingShape(installedShape);
      return;
    }

    if (existingBaseTables.length > 0) {
      throw new Error(
        `Partial billing schema detected in integration env: ${existingBaseTables.join(', ')}`
      );
    }

    let appliedRpcMigration = false;

    for (const filename of BILLING_MIGRATION_FILES) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      const { error } = await serviceClient.rpc('exec_sql', { query: sql });
      expect(error).toBeNull();

      if (
        filename === '011_billing_concurrency_guards.sql'
        || filename === '013_billing_checkout_sessions.sql'
        || filename === '014_billing_checkout_premium_plan_rename.sql'
        || filename === '015_fix_billing_subscription_event_rpc_ambiguity.sql'
        || filename === '026_require_authoritative_billing_snapshot.sql'
      ) {
        appliedRpcMigration = true;
      }
    }

    if (appliedRpcMigration) {
      await reloadPostgrestSchema();
    }

    const installedShape = await getInstalledBillingShape();
    assertInstalledBillingShape(installedShape);
  }

  async function createTempUser(prefix) {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      email_confirm: true,
    });

    if (error) throw error;

    const tempUserId = data?.user?.id;
    if (!tempUserId) {
      throw new Error(`createUser returned no id for ${email}`);
    }

    cleanupUserIds.add(tempUserId);
    return tempUserId;
  }

  async function ensureBillingCustomer(userId, extraFields = {}) {
    const result = await serviceClient.from('billing_customers').upsert({
      user_id: userId,
      ...extraFields,
    });

    expect(result.error).toBeNull();
  }

  /**
   * Remove billing rows owned by a test user.
   *
   * Purpose: baseline and temporary users need deterministic cleanup across all
   * billing tables without deleting the auth user itself.
   *
   * @param {string} userId Supabase auth user id whose billing rows are removed.
   * @returns {Promise<void>}
   * Side effects/connections: deletes rows through serviceClient from
   * billing_checkout_sessions, billing_subscriptions, and billing_customers;
   * throws on cleanup errors or unexpected delete statuses so leaked state does
   * not carry into later tests. Callers manage cleanupUserIds and admin auth
   * deletion separately.
   */
  async function cleanupBillingRowsForUser(userId) {
    const expectedDeleteStatuses = new Set([200, 204]);
    const deleteResults = [
      [
        'billing_checkout_sessions',
        await serviceClient.from('billing_checkout_sessions').delete().eq('user_id', userId),
      ],
      [
        'billing_subscriptions',
        await serviceClient.from('billing_subscriptions').delete().eq('user_id', userId),
      ],
      [
        'billing_customers',
        await serviceClient.from('billing_customers').delete().eq('user_id', userId),
      ],
    ];

    for (const [tableName, result] of deleteResults) {
      if (result.error) {
        throw new Error(
          `Failed to clean up ${tableName} rows for ${userId}: ${result.error.message}`
        );
      }

      if (!expectedDeleteStatuses.has(result.status)) {
        throw new Error(
          `Unexpected cleanup status ${result.status} for ${tableName} rows owned by ${userId}`
        );
      }
    }
  }

  async function clearBaselineRows() {
    await cleanupBillingRowsForUser(userAId);
    await cleanupBillingRowsForUser(userBId);
  }

  beforeAll(async () => {
    const { createClient } = await import('@supabase/supabase-js');

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });
    anonClient = createClient(TEST_URL, TEST_ANON_KEY, {
      auth: { persistSession: false },
    });

    const adminAuth = serviceClient.auth.admin;

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

    if (!userAId || !userBId) {
      const { data } = await adminAuth.listUsers();
      userAId = userAId || data?.users?.find((user) => user.email === USER_A_EMAIL)?.id;
      userBId = userBId || data?.users?.find((user) => user.email === USER_B_EMAIL)?.id;
    }

    await ensureBillingMigrationsApplied();

    clientA = await signInAsUser(createClient, serviceClient, USER_A_EMAIL);
    clientB = await signInAsUser(createClient, serviceClient, USER_B_EMAIL);

    await clearBaselineRows();
  });

  afterAll(async () => {
    for (const eventId of cleanupEventIds) {
      await serviceClient.from('stripe_event_receipts').delete().eq('event_id', eventId);
    }

    await clearBaselineRows();

    for (const tempUserId of cleanupUserIds) {
      await cleanupBillingRowsForUser(tempUserId);
      await serviceClient.auth.admin.deleteUser(tempUserId);
    }

    if (userAId) {
      await serviceClient.auth.admin.deleteUser(userAId);
    }

    if (userBId) {
      await serviceClient.auth.admin.deleteUser(userBId);
    }
  });

  test('B1: local/session billing migrations through additive 026 exist in the repo-root migrations folder', () => {
    for (const filename of BILLING_MIGRATION_FILES) {
      expect(existsSync(join(MIGRATIONS_DIR, filename))).toBe(true);
    }
  });

  test('B2: two different users can hold placeholder billing_customers rows simultaneously', async () => {
    const upsertA = await serviceClient.from('billing_customers').upsert({
      user_id: userAId,
      stripe_customer_id: null,
    });
    const upsertB = await serviceClient.from('billing_customers').upsert({
      user_id: userBId,
      stripe_customer_id: null,
    });

    expect(upsertA.error).toBeNull();
    expect(upsertB.error).toBeNull();

    const { data, error } = await serviceClient
      .from('billing_customers')
      .select('user_id, stripe_customer_id')
      .in('user_id', [userAId, userBId])
      .order('user_id', { ascending: true });

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(data.every((row) => row.stripe_customer_id === null)).toBe(true);
  });

  test('B3: duplicate non-null billing_customers.stripe_customer_id values are rejected', async () => {
    const sharedCustomerId = `cus_dup_${Date.now()}`;

    const updateA = await serviceClient
      .from('billing_customers')
      .update({ stripe_customer_id: sharedCustomerId })
      .eq('user_id', userAId);

    expect(updateA.error).toBeNull();

    const updateB = await serviceClient
      .from('billing_customers')
      .update({ stripe_customer_id: sharedCustomerId })
      .eq('user_id', userBId);

    expect(updateB.error).toBeTruthy();
    expect(buildPermissionMessage(updateB.error)).toMatch(/duplicate|unique|23505/i);
  });

  test('B4: billing_customers.updated_at increases after a service update', async () => {
    const { data: beforeData, error: beforeError } = await serviceClient
      .from('billing_customers')
      .select('updated_at')
      .eq('user_id', userAId)
      .single();

    expect(beforeError).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const update = await serviceClient
      .from('billing_customers')
      .update({ stripe_customer_id: `cus_updated_${Date.now()}` })
      .eq('user_id', userAId);

    expect(update.error).toBeNull();

    const { data: afterData, error: afterError } = await serviceClient
      .from('billing_customers')
      .select('updated_at')
      .eq('user_id', userAId)
      .single();

    expect(afterError).toBeNull();
    expect(new Date(afterData.updated_at).getTime()).toBeGreaterThan(
      new Date(beforeData.updated_at).getTime()
    );
  });

  test('B5: billing_customers RLS lets a user read their own row, not another user row, and blocks writes', async () => {
    const ownRow = await clientA.from('billing_customers')
      .select('user_id')
      .eq('user_id', userAId)
      .single();

    expect(ownRow.error).toBeNull();
    expect(ownRow.data.user_id).toBe(userAId);

    const otherRow = await clientA.from('billing_customers')
      .select('user_id')
      .eq('user_id', userBId);

    expect(otherRow.error).toBeNull();
    expect(otherRow.data).toHaveLength(0);

    const { data: beforeData } = await serviceClient
      .from('billing_customers')
      .select('stripe_customer_id')
      .eq('user_id', userAId)
      .single();

    const writeAttempt = await clientA.from('billing_customers')
      .update({ stripe_customer_id: `cus_client_write_${Date.now()}` })
      .eq('user_id', userAId);

    if (writeAttempt.error) {
      expectPermissionError(writeAttempt.error);
    }

    const { data: afterData, error: afterError } = await serviceClient
      .from('billing_customers')
      .select('stripe_customer_id')
      .eq('user_id', userAId)
      .single();

    expect(afterError).toBeNull();
    expect(afterData.stripe_customer_id).toBe(beforeData.stripe_customer_id);
  });

  test('B6: malformed billing_customers Stripe customer ids are rejected', async () => {
    const malformedUserId = await createTempUser('billing-customer-malformed');
    const insert = await serviceClient.from('billing_customers').insert({
      user_id: malformedUserId,
      stripe_customer_id: 'cus_',
    });

    expect(insert.error).toBeTruthy();
    expect(buildPermissionMessage(insert.error)).toMatch(/check|constraint|23514/i);
  });

  test('B7: billing_subscriptions accepts an allowed status and stores expected timestamps', async () => {
    await ensureBillingCustomer(userAId);

    const insert = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userAId,
      stripe_subscription_id: `sub_allowed_${Date.now()}`,
      stripe_customer_id: `cus_for_sub_${Date.now()}`,
      price_id: 'price_monthly_demo',
      status: 'active',
      current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
      cancel_at_period_end: false,
      last_stripe_event_created: new Date().toISOString(),
    });

    expect(insert.error).toBeNull();

    const { data, error } = await serviceClient
      .from('billing_subscriptions')
      .select('status, last_stripe_event_created, status_changed_at, created_at, updated_at')
      .eq('user_id', userAId)
      .single();

    expect(error).toBeNull();
    expect(data.status).toBe('active');
    expect(data.last_stripe_event_created).toBeTruthy();
    expect(data.status_changed_at).toBeTruthy();
    expect(data.created_at).toBeTruthy();
    expect(data.updated_at).toBeTruthy();
  });

  test('B8: invalid billing_subscriptions statuses are rejected', async () => {
    await ensureBillingCustomer(userBId);

    const invalidInsert = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userBId,
      stripe_subscription_id: `sub_invalid_status_${Date.now()}`,
      status: 'grace_period',
    });

    expect(invalidInsert.error).toBeTruthy();
    expect(buildPermissionMessage(invalidInsert.error)).toMatch(/check|constraint|23514/i);
  });

  test('B9: duplicate billing_subscriptions.stripe_subscription_id values are rejected', async () => {
    const duplicateSubscriptionId = `sub_duplicate_${Date.now()}`;

    await ensureBillingCustomer(userAId);
    await ensureBillingCustomer(userBId);

    const first = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userAId,
      stripe_subscription_id: duplicateSubscriptionId,
      status: 'active',
    });
    expect(first.error).toBeNull();

    const second = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userBId,
      stripe_subscription_id: duplicateSubscriptionId,
      status: 'active',
    });

    expect(second.error).toBeTruthy();
    expect(buildPermissionMessage(second.error)).toMatch(/duplicate|unique|23505/i);
  });

  test('B10: billing_subscriptions.updated_at increases after update and status_changed_at is unchanged on non-status updates', async () => {
    const baselineId = `sub_status_stable_${Date.now()}`;
    const baselineCustomerId = `cus_status_stable_${Date.now()}`;
    const attemptedDrift = new Date(Date.now() + 864_000_000).toISOString();

    await ensureBillingCustomer(userAId);

    const seed = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userAId,
      stripe_subscription_id: baselineId,
      stripe_customer_id: baselineCustomerId,
      price_id: 'price_before_update',
      status: 'active',
    });
    expect(seed.error).toBeNull();

    const { data: beforeData, error: beforeError } = await serviceClient
      .from('billing_subscriptions')
      .select('updated_at, status_changed_at')
      .eq('user_id', userAId)
      .single();

    expect(beforeError).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const update = await serviceClient
      .from('billing_subscriptions')
      .update({
        price_id: 'price_after_update',
        current_period_end: new Date(Date.now() + 172_800_000).toISOString(),
        status_changed_at: attemptedDrift,
      })
      .eq('user_id', userAId);

    expect(update.error).toBeNull();

    const { data: afterData, error: afterError } = await serviceClient
      .from('billing_subscriptions')
      .select('updated_at, status_changed_at')
      .eq('user_id', userAId)
      .single();

    expect(afterError).toBeNull();
    expect(new Date(afterData.updated_at).getTime()).toBeGreaterThan(
      new Date(beforeData.updated_at).getTime()
    );
    expect(afterData.status_changed_at).toBe(beforeData.status_changed_at);
  });

  test('B10b: billing_subscriptions.status_changed_at advances when status changes', async () => {
    const baselineId = `sub_status_change_${Date.now()}`;

    await ensureBillingCustomer(userAId);

    const seed = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userAId,
      stripe_subscription_id: baselineId,
      status: 'active',
      price_id: 'price_status_before',
    });
    expect(seed.error).toBeNull();

    const { data: beforeData, error: beforeError } = await serviceClient
      .from('billing_subscriptions')
      .select('updated_at, status, status_changed_at')
      .eq('user_id', userAId)
      .single();

    expect(beforeError).toBeNull();
    expect(beforeData.status).toBe('active');

    await new Promise((resolve) => setTimeout(resolve, 20));

    const update = await serviceClient
      .from('billing_subscriptions')
      .update({
        status: 'past_due',
        price_id: 'price_status_after',
      })
      .eq('user_id', userAId);

    expect(update.error).toBeNull();

    const { data: afterData, error: afterError } = await serviceClient
      .from('billing_subscriptions')
      .select('updated_at, status, status_changed_at')
      .eq('user_id', userAId)
      .single();

    expect(afterError).toBeNull();
    expect(afterData.status).toBe('past_due');
    expect(new Date(afterData.updated_at).getTime()).toBeGreaterThan(
      new Date(beforeData.updated_at).getTime()
    );
    expect(new Date(afterData.status_changed_at).getTime()).toBeGreaterThan(
      new Date(beforeData.status_changed_at).getTime()
    );
  });

  test('B11: billing_subscriptions RLS lets a user read their own row, not another user row, and blocks writes', async () => {
    await ensureBillingCustomer(userAId);
    await ensureBillingCustomer(userBId);

    const seedA = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userAId,
      stripe_subscription_id: `sub_user_a_${Date.now()}`,
      price_id: 'price_user_a_before',
      status: 'active',
    });
    expect(seedA.error).toBeNull();

    const seedB = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userBId,
      stripe_subscription_id: `sub_user_b_${Date.now()}`,
      status: 'active',
    });
    expect(seedB.error).toBeNull();

    const ownRow = await clientA.from('billing_subscriptions')
      .select('user_id')
      .eq('user_id', userAId)
      .single();

    expect(ownRow.error).toBeNull();
    expect(ownRow.data.user_id).toBe(userAId);

    const otherRow = await clientA.from('billing_subscriptions')
      .select('user_id')
      .eq('user_id', userBId);

    expect(otherRow.error).toBeNull();
    expect(otherRow.data).toHaveLength(0);

    const { data: beforeData } = await serviceClient
      .from('billing_subscriptions')
      .select('price_id')
      .eq('user_id', userAId)
      .single();

    const writeAttempt = await clientA.from('billing_subscriptions')
      .update({ price_id: 'price_client_write_attempt' })
      .eq('user_id', userAId);

    if (writeAttempt.error) {
      expectPermissionError(writeAttempt.error);
    }

    const { data: afterData, error: afterError } = await serviceClient
      .from('billing_subscriptions')
      .select('price_id')
      .eq('user_id', userAId)
      .single();

    expect(afterError).toBeNull();
    expect(afterData.price_id).toBe(beforeData.price_id);
  });

  test('B12: malformed billing_subscriptions Stripe ids are rejected', async () => {
    const malformedSubscriptionUserId = await createTempUser('billing-sub-malformed');

    await ensureBillingCustomer(malformedSubscriptionUserId);

    const malformedSubscription = await serviceClient.from('billing_subscriptions').insert({
      user_id: malformedSubscriptionUserId,
      stripe_subscription_id: 'sub_',
      status: 'active',
    });

    expect(malformedSubscription.error).toBeTruthy();
    expect(buildPermissionMessage(malformedSubscription.error)).toMatch(/check|constraint|23514/i);

    const malformedCustomer = await serviceClient.from('billing_subscriptions').insert({
      user_id: malformedSubscriptionUserId,
      stripe_subscription_id: `sub_validish_${Date.now()}`,
      stripe_customer_id: 'cus_',
      status: 'active',
    });

    expect(malformedCustomer.error).toBeTruthy();
    expect(buildPermissionMessage(malformedCustomer.error)).toMatch(/check|constraint|23514/i);
  });

  test('B13: authenticated clients cannot read stripe_event_receipts', async () => {
    const eventId = `evt_auth_blocked_${Date.now()}`;
    cleanupEventIds.add(eventId);

    const seed = await serviceClient.from('stripe_event_receipts').insert({
      event_id: eventId,
      event_type: 'customer.subscription.updated',
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'processed',
    });
    expect(seed.error).toBeNull();

    const result = await clientA.from('stripe_event_receipts').select('*');

    // Explicit ACL hardening may surface as either zero visible rows or a
    // permission failure, depending on the API path used by the client.
    expectZeroRowsOrPermission(result);
  });

  test('B14: authenticated clients cannot insert into stripe_event_receipts', async () => {
    const eventId = `evt_auth_insert_${Date.now()}`;

    const insertAttempt = await clientA.from('stripe_event_receipts').insert({
      event_id: eventId,
      event_type: 'customer.subscription.updated',
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'processed',
    });

    expectPermissionOrNullData(insertAttempt);

    const { data, error } = await serviceClient
      .from('stripe_event_receipts')
      .select('event_id')
      .eq('event_id', eventId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('B15: authenticated clients cannot update or delete stripe_event_receipts', async () => {
    const eventId = `evt_auth_write_blocked_${Date.now()}`;
    cleanupEventIds.add(eventId);

    const seed = await serviceClient.from('stripe_event_receipts').insert({
      event_id: eventId,
      event_type: 'customer.subscription.updated',
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'processed',
    });
    expect(seed.error).toBeNull();

    const updateAttempt = await clientA.from('stripe_event_receipts')
      .update({ result: 'failed' })
      .eq('event_id', eventId);

    expectPermissionOrNullData(updateAttempt);

    const { data: afterUpdate, error: afterUpdateError } = await serviceClient
      .from('stripe_event_receipts')
      .select('event_id, result')
      .eq('event_id', eventId)
      .single();

    expect(afterUpdateError).toBeNull();
    expect(afterUpdate.result).toBe('processed');

    const deleteAttempt = await clientA.from('stripe_event_receipts')
      .delete()
      .eq('event_id', eventId);

    expectPermissionOrNullData(deleteAttempt);

    const { data: afterDelete, error: afterDeleteError } = await serviceClient
      .from('stripe_event_receipts')
      .select('event_id')
      .eq('event_id', eventId);

    expect(afterDeleteError).toBeNull();
    expect(afterDelete).toHaveLength(1);
  });

  test('B16: anon clients cannot access billing tables and cannot write stripe_event_receipts', async () => {
    expectZeroRowsOrPermission(
      await anonClient.from('billing_customers').select('*')
    );
    expectZeroRowsOrPermission(
      await anonClient.from('billing_subscriptions').select('*')
    );
    expectZeroRowsOrPermission(
      await anonClient.from('stripe_event_receipts').select('*')
    );
    expectZeroRowsOrPermission(
      await anonClient.from('billing_checkout_sessions').select('*')
    );

    const eventId = `evt_anon_insert_${Date.now()}`;
    const insertAttempt = await anonClient.from('stripe_event_receipts').insert({
      event_id: eventId,
      event_type: 'customer.subscription.updated',
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'processed',
    });

    expectPermissionOrNullData(insertAttempt);

    const { data, error } = await serviceClient
      .from('stripe_event_receipts')
      .select('event_id')
      .eq('event_id', eventId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('B17: stripe_event_receipts has no user-facing policies', async () => {
    const rows = await execSql(`
      SELECT policyname, roles, cmd
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'stripe_event_receipts'
    `);

    expect(rows).toHaveLength(0);
  });

  test('B18: installed billing schema matches the expected Phase 2 objects', async () => {
    const installedShape = await getInstalledBillingShape();
    assertInstalledBillingShape(installedShape);
  });

  test('B19: all billing tables force row level security', async () => {
    const rows = await execSql(`
      SELECT relname, relforcerowsecurity
      FROM pg_catalog.pg_class
      WHERE oid IN (
        'public.billing_customers'::pg_catalog.regclass,
        'public.billing_subscriptions'::pg_catalog.regclass,
        'public.stripe_event_receipts'::pg_catalog.regclass,
        'public.billing_checkout_sessions'::pg_catalog.regclass
      )
      ORDER BY relname
    `);

    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.relforcerowsecurity === true)).toBe(true);
  });

  test('B20: billing trigger helpers and billing RPCs pin search_path to pg_catalog, public and stay SECURITY INVOKER', async () => {
    const rows = await execSql(`
      SELECT proname, coalesce(proconfig, ARRAY[]::text[]) AS proconfig, prosecdef
      FROM pg_catalog.pg_proc
      WHERE pronamespace = 'public'::pg_catalog.regnamespace
        AND proname IN (
          'touch_billing_updated_at',
            '${BILLING_STATUS_CHANGED_AT_FUNCTION}',
            '${BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION}',
            '${BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION}',
            '${STRIPE_EVENT_RECEIPT_MERGE_FUNCTION}',
            '${BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION}'
          )
      ORDER BY proname
    `);

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.proname)).toEqual([
      BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION,
      STRIPE_EVENT_RECEIPT_MERGE_FUNCTION,
      BILLING_STATUS_CHANGED_AT_FUNCTION,
      'touch_billing_updated_at',
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION,
    ]);

    for (const row of rows) {
      const proconfig = row.proconfig ?? [];
      expect(proconfig).toContain('search_path=pg_catalog, public');
      expect(row.prosecdef).toBe(false);
    }
  });

  test('B21: stripe_event_receipts rejects malformed ids, invalid results, and overlong event types', async () => {
    const malformedId = await serviceClient.from('stripe_event_receipts').insert({
      event_id: 'evt_',
      event_type: 'customer.subscription.created',
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'processed',
    });
    expect(malformedId.error).toBeTruthy();
    expect(buildPermissionMessage(malformedId.error)).toMatch(/check|constraint|23514/i);

    const invalidResultEventId = `evt_invalid_result_${Date.now()}`;
    cleanupEventIds.add(invalidResultEventId);

    const invalidResult = await serviceClient.from('stripe_event_receipts').insert({
      event_id: invalidResultEventId,
      event_type: 'customer.subscription.deleted',
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'replayed',
    });
    expect(invalidResult.error).toBeTruthy();
    expect(buildPermissionMessage(invalidResult.error)).toMatch(/check|constraint|23514/i);

    const overlongTypeEventId = `evt_overlong_${Date.now()}`;
    cleanupEventIds.add(overlongTypeEventId);

    const overlongType = await serviceClient.from('stripe_event_receipts').insert({
      event_id: overlongTypeEventId,
      event_type: 'x'.repeat(256),
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'processed',
    });
    expect(overlongType.error).toBeTruthy();
    expect(buildPermissionMessage(overlongType.error)).toMatch(/check|constraint|23514/i);
  });

  test('B22: stripe_event_receipts(processed_at) index exists', async () => {
    const rows = await execSql(`
      SELECT indexname
      FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'stripe_event_receipts'
        AND indexname = 'stripe_event_receipts_processed_at_idx'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].indexname).toBe('stripe_event_receipts_processed_at_idx');
  });

  test('B23: billing FKs require customer-first subscription inserts and block teardown out of order', async () => {
    const deleteProbeUserId = await createTempUser('billing-restrict-delete');

    const subscriptionWithoutCustomer = await serviceClient.from('billing_subscriptions').insert({
      user_id: deleteProbeUserId,
      stripe_subscription_id: `sub_delete_probe_missing_customer_${Date.now()}`,
      status: 'active',
    });
    expect(subscriptionWithoutCustomer.error).toBeTruthy();
    expect(buildPermissionMessage(subscriptionWithoutCustomer.error)).toMatch(/foreign key|constraint|23503/i);

    const customerInsert = await serviceClient.from('billing_customers').insert({
      user_id: deleteProbeUserId,
      stripe_customer_id: null,
    });
    expect(customerInsert.error).toBeNull();

    const subscriptionInsert = await serviceClient.from('billing_subscriptions').insert({
      user_id: deleteProbeUserId,
      stripe_subscription_id: `sub_delete_probe_${Date.now()}`,
      status: 'active',
    });
    expect(subscriptionInsert.error).toBeNull();

    const customerDelete = await serviceClient
      .from('billing_customers')
      .delete()
      .eq('user_id', deleteProbeUserId);

    expect(customerDelete.error).toBeTruthy();
    expect(buildPermissionMessage(customerDelete.error)).toMatch(/foreign key|constraint|23503/i);

    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(deleteProbeUserId);

    expect(deleteError).toBeTruthy();

    await cleanupBillingRowsForUser(deleteProbeUserId);

    const { error: deleteAfterCleanupError } = await serviceClient.auth.admin.deleteUser(deleteProbeUserId);
    expect(deleteAfterCleanupError).toBeNull();

    cleanupUserIds.delete(deleteProbeUserId);
  });

  test('B24: service role can insert, select, update, and delete billing_customers', async () => {
    const serviceUserId = await createTempUser('billing-service-customer');

    const insert = await serviceClient.from('billing_customers').insert({
      user_id: serviceUserId,
      stripe_customer_id: null,
    });
    expect(insert.error).toBeNull();

    const { data: insertedRow, error: selectAfterInsertError } = await serviceClient
      .from('billing_customers')
      .select('user_id, stripe_customer_id')
      .eq('user_id', serviceUserId)
      .single();

    expect(selectAfterInsertError).toBeNull();
    expect(insertedRow.user_id).toBe(serviceUserId);
    expect(insertedRow.stripe_customer_id).toBeNull();

    const updatedCustomerId = `cus_service_${Date.now()}`;
    const update = await serviceClient
      .from('billing_customers')
      .update({ stripe_customer_id: updatedCustomerId })
      .eq('user_id', serviceUserId);

    expect(update.error).toBeNull();

    const { data: updatedRow, error: selectAfterUpdateError } = await serviceClient
      .from('billing_customers')
      .select('stripe_customer_id')
      .eq('user_id', serviceUserId)
      .single();

    expect(selectAfterUpdateError).toBeNull();
    expect(updatedRow.stripe_customer_id).toBe(updatedCustomerId);

    const deleteResult = await serviceClient
      .from('billing_customers')
      .delete()
      .eq('user_id', serviceUserId);

    expect(deleteResult.error).toBeNull();

    const { data: afterDeleteRows, error: selectAfterDeleteError } = await serviceClient
      .from('billing_customers')
      .select('user_id')
      .eq('user_id', serviceUserId);

    expect(selectAfterDeleteError).toBeNull();
    expect(afterDeleteRows).toHaveLength(0);
  });

  test('B25: service role can insert, select, update, and delete billing_subscriptions', async () => {
    const serviceUserId = await createTempUser('billing-service-subscription');
    const subscriptionId = `sub_service_${Date.now()}`;
    const initialCustomerId = `cus_service_sub_${Date.now()}`;

    await ensureBillingCustomer(serviceUserId);

    const insert = await serviceClient.from('billing_subscriptions').insert({
      user_id: serviceUserId,
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: initialCustomerId,
      price_id: 'price_service_insert',
      status: 'active',
    });
    expect(insert.error).toBeNull();

    const { data: insertedRow, error: selectAfterInsertError } = await serviceClient
      .from('billing_subscriptions')
      .select('user_id, stripe_subscription_id, price_id, status')
      .eq('user_id', serviceUserId)
      .single();

    expect(selectAfterInsertError).toBeNull();
    expect(insertedRow.user_id).toBe(serviceUserId);
    expect(insertedRow.stripe_subscription_id).toBe(subscriptionId);
    expect(insertedRow.price_id).toBe('price_service_insert');
    expect(insertedRow.status).toBe('active');

    const update = await serviceClient
      .from('billing_subscriptions')
      .update({
        price_id: 'price_service_updated',
        cancel_at_period_end: true,
      })
      .eq('user_id', serviceUserId);

    expect(update.error).toBeNull();

    const { data: updatedRow, error: selectAfterUpdateError } = await serviceClient
      .from('billing_subscriptions')
      .select('price_id, cancel_at_period_end')
      .eq('user_id', serviceUserId)
      .single();

    expect(selectAfterUpdateError).toBeNull();
    expect(updatedRow.price_id).toBe('price_service_updated');
    expect(updatedRow.cancel_at_period_end).toBe(true);

    const deleteResult = await serviceClient
      .from('billing_subscriptions')
      .delete()
      .eq('user_id', serviceUserId);

    expect(deleteResult.error).toBeNull();

    const { data: afterDeleteRows, error: selectAfterDeleteError } = await serviceClient
      .from('billing_subscriptions')
      .select('user_id')
      .eq('user_id', serviceUserId);

    expect(selectAfterDeleteError).toBeNull();
    expect(afterDeleteRows).toHaveLength(0);
  });

  test('B26: service role can insert, select, and delete stripe_event_receipts', async () => {
    const eventId = `evt_service_${Date.now()}`;
    cleanupEventIds.add(eventId);

    const insert = await serviceClient.from('stripe_event_receipts').insert({
      event_id: eventId,
      event_type: 'customer.subscription.updated',
      livemode: false,
      stripe_event_created: new Date().toISOString(),
      result: 'processed',
    });
    expect(insert.error).toBeNull();

    const { data: insertedRow, error: selectAfterInsertError } = await serviceClient
      .from('stripe_event_receipts')
      .select('event_id, event_type, result')
      .eq('event_id', eventId)
      .single();

    expect(selectAfterInsertError).toBeNull();
    expect(insertedRow.event_id).toBe(eventId);
    expect(insertedRow.event_type).toBe('customer.subscription.updated');
    expect(insertedRow.result).toBe('processed');

    const deleteResult = await serviceClient
      .from('stripe_event_receipts')
      .delete()
      .eq('event_id', eventId);

    expect(deleteResult.error).toBeNull();

    const { data: afterDeleteRows, error: selectAfterDeleteError } = await serviceClient
      .from('stripe_event_receipts')
      .select('event_id')
      .eq('event_id', eventId);

    expect(selectAfterDeleteError).toBeNull();
    expect(afterDeleteRows).toHaveLength(0);

    cleanupEventIds.delete(eventId);
  });

  test('B27: merge_stripe_event_receipt claims processing, retries failed rows, and preserves terminal success rows', async () => {
    const eventId = `evt_rpc_merge_${Date.now()}`;
    cleanupEventIds.add(eventId);
    const eventEnvelope = {
      p_event_id: eventId,
      p_event_type: 'invoice.payment_failed',
      p_livemode: false,
      p_stripe_event_created: '2030-01-10T00:00:00.000Z',
    };

    const recorded = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      ...eventEnvelope,
      p_result: 'processing',
    });

    expect(recorded.error).toBeNull();
    expect(recorded.data).toEqual(expect.objectContaining({
      outcome: 'recorded',
      receipt: expect.objectContaining({
        event_id: eventId,
        result: 'processing',
      }),
    }));

    const initialProcessedAt = recorded.data.receipt.processed_at;

    const activeProcessing = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      ...eventEnvelope,
      p_result: 'processing',
    });

    expect(activeProcessing.error).toBeNull();
    expect(activeProcessing.data.outcome).toBe('processing_active');
    expect(activeProcessing.data.receipt.processed_at).toBe(initialProcessedAt);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const failed = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      ...eventEnvelope,
      p_result: 'failed',
    });

    expect(failed.error).toBeNull();
    expect(failed.data.outcome).toBe('updated');
    expect(failed.data.receipt.result).toBe('failed');
    expect(new Date(failed.data.receipt.processed_at).getTime()).toBeGreaterThan(
      new Date(initialProcessedAt).getTime()
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const retried = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      ...eventEnvelope,
      p_result: 'processing',
    });

    expect(retried.error).toBeNull();
    expect(retried.data.outcome).toBe('updated');
    expect(retried.data.receipt.result).toBe('processing');
    expect(new Date(retried.data.receipt.processed_at).getTime()).toBeGreaterThan(
      new Date(failed.data.receipt.processed_at).getTime()
    );

    const staleIgnored = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      ...eventEnvelope,
      p_result: 'stale_ignored',
    });

    expect(staleIgnored.error).toBeNull();
    expect(staleIgnored.data.outcome).toBe('updated');
    expect(staleIgnored.data.receipt.result).toBe('stale_ignored');

    const preservedStale = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      ...eventEnvelope,
      p_result: 'failed',
    });

    expect(preservedStale.error).toBeNull();
    expect(preservedStale.data.outcome).toBe('preserved_existing');
    expect(preservedStale.data.receipt.result).toBe('stale_ignored');
    expect(preservedStale.data.receipt.processed_at).toBe(staleIgnored.data.receipt.processed_at);
  });

  test('B27a: merge_stripe_event_receipt rejects same-id envelope mismatches', async () => {
    const eventId = `evt_rpc_mismatch_${Date.now()}`;
    cleanupEventIds.add(eventId);

    const recorded = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      p_event_id: eventId,
      p_event_type: 'invoice.paid',
      p_livemode: false,
      p_stripe_event_created: '2030-01-10T00:00:00.000Z',
      p_result: 'processing',
    });

    expect(recorded.error).toBeNull();

    const mismatch = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      p_event_id: eventId,
      p_event_type: 'invoice.payment_failed',
      p_livemode: false,
      p_stripe_event_created: '2030-01-10T00:00:00.000Z',
      p_result: 'failed',
    });

    expect(mismatch.error).toBeTruthy();
  });

  test('B28: upsert_billing_subscription_if_newer_or_equal enforces newer-or-equal event ordering and rejects null staleness keys', async () => {
    const rpcUserId = await createTempUser('billing-rpc-event-upsert');
    const seededSubscriptionId = `sub_rpc_seed_${Date.now()}`;
    const seededCustomerId = `cus_rpc_seed_${Date.now()}`;

    await ensureBillingCustomer(rpcUserId);

    const seededSubscription = await serviceClient.from('billing_subscriptions').upsert({
      user_id: rpcUserId,
      stripe_subscription_id: seededSubscriptionId,
      stripe_customer_id: seededCustomerId,
      price_id: 'price_seed',
      status: 'active',
      current_period_end: '2030-02-01T00:00:00.000Z',
      cancel_at_period_end: false,
      last_stripe_event_created: '2030-01-10T00:00:00.000Z',
    });
    expect(seededSubscription.error).toBeNull();

    const newer = await callServiceBillingRpc(BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: seededSubscriptionId,
        stripe_customer_id: seededCustomerId,
        price_id: 'price_newer',
        status: 'active',
        current_period_end: '2030-03-01T00:00:00.000Z',
        cancel_at_period_end: true,
        last_stripe_event_created: '2030-01-11T00:00:00.000Z',
      },
    });

    expect(newer.error).toBeNull();
    expect(newer.data).toEqual(expect.objectContaining({
      applied: true,
      subscription: expect.objectContaining({
        user_id: rpcUserId,
        price_id: 'price_newer',
        cancel_at_period_end: true,
        last_stripe_event_created: '2030-01-11T00:00:00+00:00',
      }),
    }));

    const equalTimestamp = await callServiceBillingRpc(BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: newer.data.subscription.stripe_subscription_id,
        stripe_customer_id: newer.data.subscription.stripe_customer_id,
        price_id: 'price_equal',
        status: 'past_due',
        current_period_end: '2030-04-01T00:00:00.000Z',
        cancel_at_period_end: false,
        last_stripe_event_created: '2030-01-11T00:00:00.000Z',
      },
    });

    expect(equalTimestamp.error).toBeNull();
    expect(equalTimestamp.data.applied).toBe(true);
    expect(equalTimestamp.data.subscription.price_id).toBe('price_equal');
    expect(equalTimestamp.data.subscription.status).toBe('past_due');

    const older = await callServiceBillingRpc(BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: newer.data.subscription.stripe_subscription_id,
        stripe_customer_id: newer.data.subscription.stripe_customer_id,
        price_id: 'price_older',
        status: 'active',
        current_period_end: '2030-05-01T00:00:00.000Z',
        cancel_at_period_end: true,
        last_stripe_event_created: '2030-01-09T00:00:00.000Z',
      },
    });

    expect(older.error).toBeNull();
    expect(older.data.applied).toBe(false);
    expect(older.data.reason).toBe('stale_ignored');
    expect(older.data.subscription.price_id).toBe('price_equal');
    expect(older.data.subscription.status).toBe('past_due');

    const nonCurrent = await callServiceBillingRpc(BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: `sub_rpc_noncurrent_${Date.now()}`,
        stripe_customer_id: seededCustomerId,
        price_id: 'price_noncurrent',
        status: 'active',
        current_period_end: '2030-06-01T00:00:00.000Z',
        cancel_at_period_end: true,
        last_stripe_event_created: '2030-01-12T00:00:00.000Z',
      },
    });

    expect(nonCurrent.error).toBeNull();
    expect(nonCurrent.data.applied).toBe(false);
    expect(nonCurrent.data.reason).toBe('non_current_ignored');
    expect(nonCurrent.data.subscription.stripe_subscription_id).toBe(seededSubscriptionId);
    expect(nonCurrent.data.subscription.price_id).toBe('price_equal');

    const missingStalenessKey = await callServiceBillingRpc(BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: newer.data.subscription.stripe_subscription_id,
        stripe_customer_id: newer.data.subscription.stripe_customer_id,
        price_id: 'price_invalid',
        status: 'active',
        current_period_end: '2030-05-01T00:00:00.000Z',
        cancel_at_period_end: true,
      },
    });

    expect(missingStalenessKey.error).toBeTruthy();
    expect(buildPermissionMessage(missingStalenessKey.error)).toMatch(/last_stripe_event_created|required|23502/i);
  });

  test('B29: upsert_billing_subscription_authoritative honors present-vs-omitted fields and preserves the staleness key when omitted or null', async () => {
    const rpcUserId = await createTempUser('billing-rpc-authoritative-upsert');

    await ensureBillingCustomer(rpcUserId);

    const stripeSubscriptionId = `sub_rpc_authoritative_${Date.now()}`;
    const stripeCustomerId = `cus_rpc_authoritative_${Date.now()}`;

    const seededSubscription = await serviceClient
      .from('billing_subscriptions')
      .upsert({
        user_id: rpcUserId,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
        price_id: 'price_seed',
        status: 'active',
        current_period_end: '2030-02-01T00:00:00.000Z',
        cancel_at_period_end: false,
        last_stripe_event_created: '2030-01-10T00:00:00.000Z',
      })
      .select('*')
      .single();
    expect(seededSubscription.error).toBeNull();

    const omittedCurrentPeriodEnd = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: stripeCustomerId,
          price_id: 'price_overwritten',
          status: 'active',
          cancel_at_period_end: true,
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_snapshot_version:
            seededSubscription.data.snapshot_version,
          _authoritative_sync_purpose: 'reconcile_current',
        },
      }
    );

    expect(omittedCurrentPeriodEnd.error).toBeNull();
    expect(omittedCurrentPeriodEnd.data.subscription).toEqual(expect.objectContaining({
      user_id: rpcUserId,
      price_id: 'price_overwritten',
      cancel_at_period_end: true,
      current_period_end: '2030-02-01T00:00:00+00:00',
      last_stripe_event_created: '2030-01-10T00:00:00+00:00',
    }));

    const explicitNullCurrentPeriodEnd = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          status: 'canceled',
          current_period_end: null,
          last_stripe_event_created: null,
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_snapshot_version:
            omittedCurrentPeriodEnd.data.subscription.snapshot_version,
          _authoritative_sync_purpose: 'reconcile_current',
        },
      }
    );

    expect(explicitNullCurrentPeriodEnd.error).toBeNull();
    expect(explicitNullCurrentPeriodEnd.data.subscription).toEqual(expect.objectContaining({
      user_id: rpcUserId,
      status: 'canceled',
      current_period_end: null,
      last_stripe_event_created: '2030-01-10T00:00:00+00:00',
    }));
  });

  test('B29a: authoritative snapshots require exact guards, advance versions, and block unsafe replacement', async () => {
    const rpcUserId = await createTempUser('billing-rpc-authoritative-guard');
    const stripeCustomerId = `cus_rpc_authoritative_guard_${Date.now()}`;
    const stripeSubscriptionId = `sub_rpc_authoritative_guard_${Date.now()}`;

    await ensureBillingCustomer(rpcUserId, {
      stripe_customer_id: stripeCustomerId,
    });

    const missingGuard = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: stripeCustomerId,
          price_id: 'price_guard_missing',
          status: 'active',
          cancel_at_period_end: false,
        },
      }
    );
    expect(missingGuard.error).toBeTruthy();
    expect(buildPermissionMessage(missingGuard.error)).toMatch(/existence marker|boolean|22023/i);

    const contradictoryAbsence = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_exists: false,
          _expected_stripe_subscription_id: stripeSubscriptionId,
          _authoritative_sync_purpose: 'checkout_completion',
        },
      }
    );
    expect(contradictoryAbsence.error).toBeTruthy();
    expect(buildPermissionMessage(contradictoryAbsence.error)).toMatch(/absent billing snapshot|22023/i);

    const nullVersion = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_snapshot_version: null,
          _authoritative_sync_purpose: 'reconcile_current',
        },
      }
    );
    expect(nullVersion.error).toBeTruthy();
    expect(buildPermissionMessage(nullVersion.error)).toMatch(/valid expected billing snapshot|22023/i);

    const reconcileAbsent = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_exists: false,
          _authoritative_sync_purpose: 'reconcile_current',
        },
      }
    );
    expect(reconcileAbsent.error).toBeTruthy();
    expect(buildPermissionMessage(reconcileAbsent.error)).toMatch(/existing subscription snapshot|22023/i);

    const inserted = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: stripeCustomerId,
          price_id: 'price_guard_inserted',
          status: 'active',
          current_period_end: '2030-02-01T00:00:00.000Z',
          cancel_at_period_end: false,
          _expected_subscription_exists: false,
          _authoritative_sync_purpose: 'checkout_completion',
        },
      }
    );
    expect(inserted.error).toBeNull();
    expect(inserted.data.subscription.snapshot_version).toBe(1);

    const staleAbsence = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: stripeCustomerId,
          price_id: 'price_guard_stale_absence',
          status: 'active',
          cancel_at_period_end: false,
          _expected_subscription_exists: false,
          _authoritative_sync_purpose: 'checkout_completion',
        },
      }
    );
    expect(staleAbsence.error).toBeNull();
    expect(staleAbsence.data).toEqual(expect.objectContaining({
      applied: false,
      reason: 'billing_snapshot_changed',
      subscription: expect.objectContaining({
        stripe_subscription_id: stripeSubscriptionId,
        snapshot_version: 1,
      }),
    }));

    const directUpdate = await serviceClient
      .from('billing_subscriptions')
      .update({ price_id: 'price_guard_direct_update' })
      .eq('user_id', rpcUserId)
      .select('*')
      .single();
    expect(directUpdate.error).toBeNull();
    expect(directUpdate.data.snapshot_version).toBe(2);

    const reconciled = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          price_id: 'price_guard_reconciled',
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_snapshot_version: directUpdate.data.snapshot_version,
          _authoritative_sync_purpose: 'reconcile_current',
        },
      }
    );
    expect(reconciled.error).toBeNull();
    expect(reconciled.data.subscription.snapshot_version).toBe(3);

    const blockedReplacement = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: `${stripeSubscriptionId}_replacement`,
          stripe_customer_id: stripeCustomerId,
          price_id: 'price_guard_replacement',
          status: 'active',
          cancel_at_period_end: false,
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_snapshot_version:
            reconciled.data.subscription.snapshot_version,
          _authoritative_sync_purpose: 'checkout_completion',
        },
      }
    );
    expect(blockedReplacement.error).toBeNull();
    expect(blockedReplacement.data).toEqual(expect.objectContaining({
      applied: false,
      reason: 'subscription_replacement_blocked',
      subscription: expect.objectContaining({
        stripe_subscription_id: stripeSubscriptionId,
        snapshot_version: 3,
      }),
    }));

    const terminalRow = await serviceClient
      .from('billing_subscriptions')
      .update({ status: 'canceled' })
      .eq('user_id', rpcUserId)
      .select('*')
      .single();
    expect(terminalRow.error).toBeNull();
    expect(terminalRow.data.snapshot_version).toBe(4);

    const allowedReplacementId = `${stripeSubscriptionId}_allowed`;
    const allowedReplacement = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          stripe_subscription_id: allowedReplacementId,
          stripe_customer_id: stripeCustomerId,
          price_id: 'price_guard_allowed_replacement',
          status: 'active',
          cancel_at_period_end: false,
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id: stripeSubscriptionId,
          _expected_subscription_snapshot_version: terminalRow.data.snapshot_version,
          _authoritative_sync_purpose: 'checkout_completion',
        },
      }
    );
    expect(allowedReplacement.error).toBeNull();
    expect(allowedReplacement.data).toEqual(expect.objectContaining({
      applied: true,
      subscription: expect.objectContaining({
        stripe_subscription_id: allowedReplacementId,
        status: 'active',
        snapshot_version: 5,
      }),
    }));
  });

  test('B30: service_role can execute all three billing RPCs', async () => {
    const rpcUserId = await createTempUser('billing-rpc-permissions-service');

    await ensureBillingCustomer(rpcUserId);

    const eventId = `evt_rpc_permissions_service_${Date.now()}`;
    cleanupEventIds.add(eventId);

    const mergeReceipt = await callServiceBillingRpc(STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      p_event_id: eventId,
      p_event_type: 'customer.subscription.updated',
      p_livemode: false,
      p_stripe_event_created: '2030-01-10T00:00:00.000Z',
      p_result: 'processed',
    });
    expect(mergeReceipt.error).toBeNull();

    const eventUpsert = await callServiceBillingRpc(BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: `sub_rpc_permissions_service_${Date.now()}`,
        stripe_customer_id: `cus_rpc_permissions_service_${Date.now()}`,
        price_id: 'price_service_permissions',
        status: 'active',
        current_period_end: '2030-02-01T00:00:00.000Z',
        cancel_at_period_end: false,
        last_stripe_event_created: '2030-01-10T00:00:00.000Z',
      },
    });
    expect(eventUpsert.error).toBeNull();

    const authoritativeUpsert = await callServiceBillingRpc(
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          price_id: 'price_service_permissions_updated',
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id:
            eventUpsert.data.subscription.stripe_subscription_id,
          _expected_subscription_snapshot_version:
            eventUpsert.data.subscription.snapshot_version,
          _authoritative_sync_purpose: 'reconcile_current',
        },
      }
    );
    expect(authoritativeUpsert.error).toBeNull();
  });

  test('B31: authenticated clients cannot execute billing RPCs', async () => {
    const rpcUserId = await createTempUser('billing-rpc-permissions-auth');

    await ensureBillingCustomer(rpcUserId);

    const mergeReceipt = await callBillingRpc(clientA, STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      p_event_id: `evt_rpc_permissions_auth_${Date.now()}`,
      p_event_type: 'customer.subscription.updated',
      p_livemode: false,
      p_stripe_event_created: '2030-01-10T00:00:00.000Z',
      p_result: 'processed',
    });
    expectPermissionError(mergeReceipt.error);

    const eventUpsert = await callBillingRpc(clientA, BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: `sub_rpc_permissions_auth_${Date.now()}`,
        stripe_customer_id: `cus_rpc_permissions_auth_${Date.now()}`,
        price_id: 'price_auth_permissions',
        status: 'active',
        current_period_end: '2030-02-01T00:00:00.000Z',
        cancel_at_period_end: false,
        last_stripe_event_created: '2030-01-10T00:00:00.000Z',
      },
    });
    expectPermissionError(eventUpsert.error);

    const authoritativeUpsert = await callBillingRpc(
      clientA,
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          price_id: 'price_auth_permissions_updated',
        },
      }
    );
    expectPermissionError(authoritativeUpsert.error);
  });

  test('B32: anon clients cannot execute billing RPCs', async () => {
    const rpcUserId = await createTempUser('billing-rpc-permissions-anon');

    await ensureBillingCustomer(rpcUserId);

    const mergeReceipt = await callBillingRpc(anonClient, STRIPE_EVENT_RECEIPT_MERGE_FUNCTION, {
      p_event_id: `evt_rpc_permissions_anon_${Date.now()}`,
      p_event_type: 'customer.subscription.updated',
      p_livemode: false,
      p_stripe_event_created: '2030-01-10T00:00:00.000Z',
      p_result: 'processed',
    });
    expectPermissionError(mergeReceipt.error);

    const eventUpsert = await callBillingRpc(anonClient, BILLING_SUBSCRIPTION_EVENT_UPSERT_FUNCTION, {
      payload: {
        user_id: rpcUserId,
        stripe_subscription_id: `sub_rpc_permissions_anon_${Date.now()}`,
        stripe_customer_id: `cus_rpc_permissions_anon_${Date.now()}`,
        price_id: 'price_anon_permissions',
        status: 'active',
        current_period_end: '2030-02-01T00:00:00.000Z',
        cancel_at_period_end: false,
        last_stripe_event_created: '2030-01-10T00:00:00.000Z',
      },
    });
    expectPermissionError(eventUpsert.error);

    const authoritativeUpsert = await callBillingRpc(
      anonClient,
      BILLING_SUBSCRIPTION_AUTHORITATIVE_UPSERT_FUNCTION,
      {
        payload: {
          user_id: rpcUserId,
          price_id: 'price_anon_permissions_updated',
        },
      }
    );
    expectPermissionError(authoritativeUpsert.error);
  });

  test('B33: service_role can execute claim_billing_checkout_session', async () => {
    const rpcUserId = await createTempUser('billing-checkout-rpc-service');

    const claim = await callServiceBillingRpc(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: rpcUserId,
      p_plan: 'premium_monthly',
    });

    expect(claim.error).toBeNull();
    expect(claim.data).toEqual(expect.objectContaining({
      action: 'claimed',
      session: expect.objectContaining({
        user_id: rpcUserId,
        plan: 'premium_monthly',
        status: 'creating',
      }),
    }));
  });

  test('B34: authenticated and anon clients cannot execute claim_billing_checkout_session', async () => {
    const authAttempt = await callBillingRpc(clientA, BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: userAId,
      p_plan: 'premium_monthly',
    });
    expectPermissionError(authAttempt.error);

    const anonAttempt = await callBillingRpc(anonClient, BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: userAId,
      p_plan: 'premium_monthly',
    });
    expectPermissionError(anonAttempt.error);
  });

  test('B35: billing_checkout_sessions allows only one active row for a user and plan', async () => {
    const checkoutUserId = await createTempUser('billing-checkout-active-unique');

    const first = await serviceClient.from('billing_checkout_sessions').insert({
      user_id: checkoutUserId,
      plan: 'premium_monthly',
      status: 'creating',
    });
    expect(first.error).toBeNull();

    const second = await serviceClient.from('billing_checkout_sessions').insert({
      user_id: checkoutUserId,
      plan: 'premium_monthly',
      status: 'creating',
    });
    expect(second.error).toBeTruthy();
    expect(buildPermissionMessage(second.error)).toMatch(/duplicate|unique|23505/i);
  });

  test('B36: claim_billing_checkout_session marks stale creating rows failed', async () => {
    const checkoutUserId = await createTempUser('billing-checkout-stale-creating');

    const staleInsert = await serviceClient
      .from('billing_checkout_sessions')
      .insert({
        user_id: checkoutUserId,
        plan: 'premium_monthly',
        status: 'creating',
        updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      })
      .select('id')
      .single();
    expect(staleInsert.error).toBeNull();

    const claim = await callServiceBillingRpc(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: checkoutUserId,
      p_plan: 'premium_monthly',
    });
    expect(claim.error).toBeNull();
    expect(claim.data.action).toBe('claimed');

    const staleAfterClaim = await serviceClient
      .from('billing_checkout_sessions')
      .select('status')
      .eq('id', staleInsert.data.id)
      .single();
    expect(staleAfterClaim.error).toBeNull();
    expect(staleAfterClaim.data.status).toBe('failed');
  });

  test('B37: claim_billing_checkout_session marks locally expired open rows expired', async () => {
    const checkoutUserId = await createTempUser('billing-checkout-expired-open');
    const checkoutSessionId = `cs_test_expired_${Date.now()}`;

    const expiredInsert = await serviceClient
      .from('billing_checkout_sessions')
      .insert({
        user_id: checkoutUserId,
        plan: 'premium_monthly',
        stripe_checkout_session_id: checkoutSessionId,
        checkout_url: `https://checkout.stripe.test/${checkoutSessionId}`,
        status: 'open',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .select('id')
      .single();
    expect(expiredInsert.error).toBeNull();

    const claim = await callServiceBillingRpc(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: checkoutUserId,
      p_plan: 'premium_monthly',
    });
    expect(claim.error).toBeNull();
    expect(claim.data.action).toBe('claimed');

    const expiredAfterClaim = await serviceClient
      .from('billing_checkout_sessions')
      .select('status')
      .eq('id', expiredInsert.data.id)
      .single();
    expect(expiredAfterClaim.error).toBeNull();
    expect(expiredAfterClaim.data.status).toBe('expired');
  });

  test('B38: claim_billing_checkout_session reuses a fresh open row', async () => {
    const checkoutUserId = await createTempUser('billing-checkout-reuse-open');
    const checkoutSessionId = `cs_test_reuse_${Date.now()}`;
    const checkoutUrl = `https://checkout.stripe.test/${checkoutSessionId}`;

    const openInsert = await serviceClient.from('billing_checkout_sessions').insert({
      user_id: checkoutUserId,
      plan: 'premium_monthly',
      stripe_checkout_session_id: checkoutSessionId,
      checkout_url: checkoutUrl,
      status: 'open',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(openInsert.error).toBeNull();

    const claim = await callServiceBillingRpc(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: checkoutUserId,
      p_plan: 'premium_monthly',
    });
    expect(claim.error).toBeNull();
    expect(claim.data).toEqual(expect.objectContaining({
      action: 'reused',
      session: expect.objectContaining({
        user_id: checkoutUserId,
        plan: 'premium_monthly',
        stripe_checkout_session_id: checkoutSessionId,
        checkout_url: checkoutUrl,
        status: 'open',
      }),
    }));
  });

  test('B39: claim_billing_checkout_session rejects unsupported checkout plans', async () => {
    const checkoutUserId = await createTempUser('billing-checkout-invalid-plan-rpc');

    const claim = await callServiceBillingRpc(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: checkoutUserId,
      p_plan: 'unsupported_plan',
    });

    expect(claim.error).toBeTruthy();
    expect(buildPermissionMessage(claim.error)).toMatch(/unsupported billing plan|22023/i);
  });

  test('B40: billing_checkout_sessions rejects unsupported plan rows', async () => {
    const checkoutUserId = await createTempUser('billing-checkout-invalid-plan-row');

    const insert = await serviceClient.from('billing_checkout_sessions').insert({
      user_id: checkoutUserId,
      plan: 'unsupported_plan',
      status: 'creating',
    });

    expect(insert.error).toBeTruthy();
    expect(buildPermissionMessage(insert.error)).toMatch(/check|constraint|23514/i);
  });

  test('B41: checkout session boundaries reject the legacy resume-tailor plan name', async () => {
    const checkoutUserId = await createTempUser('billing-checkout-legacy-plan');

    const claim = await callServiceBillingRpc(BILLING_CHECKOUT_SESSION_CLAIM_FUNCTION, {
      p_user_id: checkoutUserId,
      p_plan: 'resume_tailor_monthly',
    });

    expect(claim.error).toBeTruthy();
    expect(buildPermissionMessage(claim.error)).toMatch(/unsupported billing plan|22023/i);

    const insert = await serviceClient.from('billing_checkout_sessions').insert({
      user_id: checkoutUserId,
      plan: 'resume_tailor_monthly',
      status: 'creating',
    });

    expect(insert.error).toBeTruthy();
    expect(buildPermissionMessage(insert.error)).toMatch(/check|constraint|23514/i);
  });
});
