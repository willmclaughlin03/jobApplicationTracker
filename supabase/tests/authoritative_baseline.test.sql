BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions, pg_catalog;

SELECT plan(71);

-- Catalog assertions pin the baseline fingerprint without relying on row data.
SELECT is(
  (
    SELECT array_agg(extname ORDER BY extname)::text
    FROM pg_extension
    WHERE extname IN ('moddatetime', 'uuid-ossp')
  ),
  '{moddatetime,uuid-ossp}',
  '1: required application extensions are installed'
);

SELECT is(
  (
    SELECT array_agg(c.relname ORDER BY c.relname)::text
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
  ),
  '{abuse_counters,billing_checkout_sessions,billing_customers,billing_subscriptions,daily_spend,jobs,stripe_event_receipts,tailor_cache,user_profiles}',
  '2: public table inventory matches the authoritative baseline'
);

SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'abuse_counters'), '{user_id,strike_type,count,window_start,disabled_at}', '3: abuse_counters columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_checkout_sessions'), '{id,user_id,plan,stripe_checkout_session_id,checkout_url,status,expires_at,created_at,updated_at}', '4: billing_checkout_sessions columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_customers'), '{user_id,stripe_customer_id,created_at,updated_at,last_synced_stripe_email_fingerprint}', '5: billing_customers columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_subscriptions'), '{user_id,stripe_subscription_id,stripe_customer_id,price_id,status,current_period_end,cancel_at_period_end,last_stripe_event_created,status_changed_at,created_at,updated_at,snapshot_version}', '6: billing_subscriptions columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_spend'), '{date,total_cost_cents}', '7: daily_spend columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs'), '{id,user_id,company,position,status,notes,created_at,updated_at,status_date,salary_min,salary_max,storage_state,locked_at,locked_reason,locked_policy_version}', '8: jobs columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stripe_event_receipts'), '{event_id,event_type,livemode,processed_at,stripe_event_created,result}', '9: stripe_event_receipts columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tailor_cache'), '{hash,user_id,response,created_at}', '10: tailor_cache columns match');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_profiles'), '{user_id,summary,experience,skills_technical,skills_soft,education,certifications,updated_at}', '11: user_profiles columns match');

SELECT is(
  (
    SELECT string_agg(c.relname || '.' || a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), '|' ORDER BY c.relname, a.attnum)
    FROM pg_attrdef AS d
    JOIN pg_attribute AS a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    JOIN pg_class AS c ON c.oid = d.adrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  ),
  $expected$abuse_counters.count=0|abuse_counters.window_start=now()|billing_checkout_sessions.created_at=now()|billing_checkout_sessions.updated_at=now()|billing_customers.created_at=now()|billing_customers.updated_at=now()|billing_subscriptions.cancel_at_period_end=false|billing_subscriptions.status_changed_at=now()|billing_subscriptions.created_at=now()|billing_subscriptions.updated_at=now()|billing_subscriptions.snapshot_version=1|daily_spend.total_cost_cents=0|jobs.id=uuid_generate_v4()|jobs.created_at=now()|jobs.updated_at=now()|jobs.status_date=now()|jobs.storage_state='active'::text|stripe_event_receipts.processed_at=now()|tailor_cache.created_at=now()|user_profiles.updated_at=now()$expected$,
  '12: all public column defaults match'
);

SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.abuse_counters'::regclass), '{abuse_counters_pkey,abuse_counters_user_id_fkey}', '13: abuse_counters constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.billing_checkout_sessions'::regclass), '{billing_checkout_sessions_open_fields_check,billing_checkout_sessions_pkey,billing_checkout_sessions_plan_allowed_check,billing_checkout_sessions_plan_format_check,billing_checkout_sessions_status_check,billing_checkout_sessions_stripe_session_id_format_check,billing_checkout_sessions_user_id_fkey}', '14: billing_checkout_sessions constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.billing_customers'::regclass), '{billing_customers_last_synced_stripe_email_fingerprint_format_c,billing_customers_pkey,billing_customers_stripe_customer_id_format_check,billing_customers_user_id_fkey}', '15: billing_customers constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.billing_subscriptions'::regclass), '{billing_subscriptions_billing_customers_user_id_fkey,billing_subscriptions_pkey,billing_subscriptions_snapshot_version_check,billing_subscriptions_status_check,billing_subscriptions_stripe_customer_id_format_check,billing_subscriptions_stripe_subscription_id_format_check,billing_subscriptions_stripe_subscription_id_key,billing_subscriptions_user_id_fkey}', '16: billing_subscriptions constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.daily_spend'::regclass), '{daily_spend_pkey}', '17: daily_spend constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.jobs'::regclass), '{jobs_locked_metadata_consistency_check,jobs_locked_policy_version_format_check,jobs_locked_reason_allowed_check,jobs_pkey,jobs_salary_max_check,jobs_salary_min_check,jobs_salary_range_check,jobs_storage_state_allowed_check,jobs_user_id_fkey,salary_range_valid}', '18: jobs constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.stripe_event_receipts'::regclass), '{stripe_event_receipts_event_id_format_check,stripe_event_receipts_event_type_length_check,stripe_event_receipts_pkey,stripe_event_receipts_result_check}', '19: stripe_event_receipts constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.tailor_cache'::regclass), '{tailor_cache_pkey,tailor_cache_user_id_fkey}', '20: tailor_cache constraints match');
SELECT is((SELECT array_agg(con.conname ORDER BY con.conname)::text FROM pg_constraint AS con WHERE con.conrelid = 'public.user_profiles'::regclass), '{user_profiles_pkey,user_profiles_user_id_fkey}', '21: user_profiles constraints match');

SELECT is(
  (
    SELECT string_agg(c.relname || '.' || con.conname || ':' || con.confdeltype::text, '|' ORDER BY c.relname, con.conname)
    FROM pg_constraint AS con
    JOIN pg_class AS c ON c.oid = con.conrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND con.contype = 'f'
  ),
  'abuse_counters.abuse_counters_user_id_fkey:c|billing_checkout_sessions.billing_checkout_sessions_user_id_fkey:r|billing_customers.billing_customers_user_id_fkey:r|billing_subscriptions.billing_subscriptions_billing_customers_user_id_fkey:r|billing_subscriptions.billing_subscriptions_user_id_fkey:r|jobs.jobs_user_id_fkey:c|tailor_cache.tailor_cache_user_id_fkey:c|user_profiles.user_profiles_user_id_fkey:c',
  '22: foreign-key inventory and delete actions match'
);

SELECT is(
  (SELECT array_agg(indexname ORDER BY indexname)::text FROM pg_indexes WHERE schemaname = 'public'),
  '{abuse_counters_pkey,billing_checkout_sessions_active_user_plan_idx,billing_checkout_sessions_pkey,billing_checkout_sessions_stripe_session_id_unique_idx,billing_checkout_sessions_user_session_idx,billing_customers_pkey,billing_customers_stripe_customer_id_unique_idx,billing_subscriptions_pkey,billing_subscriptions_stripe_subscription_id_key,daily_spend_pkey,jobs_active_count_idx,jobs_active_list_idx,jobs_active_lock_selection_idx,jobs_active_overflow_lock_selection_idx,jobs_locked_bulk_delete_idx,jobs_locked_count_idx,jobs_locked_restore_selection_idx,jobs_pkey,jobs_retained_list_idx,jobs_user_id_created_at_idx,jobs_user_retained_count_idx,stripe_event_receipts_pkey,stripe_event_receipts_processed_at_idx,tailor_cache_created_at_idx,tailor_cache_pkey,user_profiles_pkey}',
  '23: exact primary, unique, and secondary index inventory matches'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_index AS i
    JOIN pg_class AS c ON c.oid = i.indexrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint AS con WHERE con.conindid = i.indexrelid)
  ),
  16::bigint,
  '24: authoritative non-constraint index count is preserved'
);

SELECT is(
  (
    SELECT array_agg(c.relname || '.' || t.tgname ORDER BY c.relname, t.tgname)::text
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ),
  '{billing_checkout_sessions.set_billing_checkout_sessions_updated_at,billing_customers.lock_billing_customers_storage_transition,billing_customers.set_billing_customers_updated_at,billing_subscriptions.advance_billing_subscription_snapshot_version,billing_subscriptions.lock_billing_subscriptions_storage_transition,billing_subscriptions.set_billing_subscriptions_status_changed_at,billing_subscriptions.set_billing_subscriptions_updated_at,user_profiles.handle_updated_at}',
  '25: trigger inventory matches'
);

SELECT is(
  (
    SELECT string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text, '|' ORDER BY c.relname)
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ),
  'abuse_counters:true:false|billing_checkout_sessions:true:true|billing_customers:true:true|billing_subscriptions:true:true|daily_spend:true:false|jobs:true:true|stripe_event_receipts:true:true|tailor_cache:true:false|user_profiles:true:false',
  '26: RLS enabled and forced states match'
);

SELECT is(
  (
    SELECT string_agg(tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || COALESCE(qual, '') || ':' || COALESCE(with_check, ''), '|' ORDER BY tablename, policyname)
    FROM pg_policies
    WHERE schemaname = 'public'
  ),
  $expected$billing_customers.billing_customers_select_own:SELECT:{authenticated}:(auth.uid() = user_id):|billing_subscriptions.billing_subscriptions_select_own:SELECT:{authenticated}:(auth.uid() = user_id):|jobs.Users can delete own jobs:DELETE:{public}:(auth.uid() = user_id):|jobs.Users can insert own jobs:INSERT:{public}::(auth.uid() = user_id)|jobs.Users can update own jobs:UPDATE:{public}:(auth.uid() = user_id):|jobs.Users can view own jobs:SELECT:{public}:(auth.uid() = user_id):|tailor_cache.Users can insert own cache entries:INSERT:{public}::(auth.uid() = user_id)|tailor_cache.Users can select own cache entries:SELECT:{public}:(auth.uid() = user_id):|user_profiles.Users can delete own profile:DELETE:{public}:(auth.uid() = user_id):|user_profiles.Users can insert own profile:INSERT:{public}::(auth.uid() = user_id)|user_profiles.Users can select own profile:SELECT:{public}:(auth.uid() = user_id):|user_profiles.Users can update own profile:UPDATE:{public}:(auth.uid() = user_id):$expected$,
  '27: policy names, commands, roles, and expressions match exactly'
);

WITH client_acl AS (
  SELECT c.relname, grantee.rolname, acl.privilege_type
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
  JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND grantee.rolname IN ('anon', 'authenticated', 'service_role')
)
SELECT is(
  (SELECT count(*) FROM client_acl WHERE relname IN ('abuse_counters', 'daily_spend', 'tailor_cache', 'user_profiles')),
  96::bigint,
  '28: observed Phase 0 tables retain broad direct grants for all client roles'
);

WITH client_acl AS (
  SELECT c.relname, grantee.rolname, acl.privilege_type
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
  JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN ('billing_checkout_sessions', 'billing_customers', 'billing_subscriptions', 'jobs', 'stripe_event_receipts')
    AND grantee.rolname IN ('anon', 'authenticated', 'service_role')
)
SELECT ok(
  (
    SELECT count(*) = 42
      AND bool_and(
        rolname = 'service_role'
        OR (
          rolname = 'authenticated'
          AND relname IN ('billing_customers', 'billing_subscriptions')
          AND privilege_type = 'SELECT'
        )
      )
    FROM client_acl
  ),
  '29: jobs and billing table ACLs preserve the service-role boundary'
);

WITH sequence_acl AS (
  SELECT c.relname, grantee.rolname, acl.privilege_type
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
  JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
  WHERE n.nspname = 'public'
    AND c.relkind = 'S'
    AND grantee.rolname IN ('anon', 'authenticated', 'service_role')
)
SELECT ok(
  (
    SELECT count(*) = 9
      AND bool_and(relname = 'billing_checkout_sessions_id_seq')
      AND bool_and(privilege_type IN ('SELECT', 'UPDATE', 'USAGE'))
    FROM sequence_acl
  ),
  '30: observed checkout identity-sequence grants match exactly'
);

SELECT is(
  (
    SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', '|' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ),
  $expected$advance_billing_subscription_snapshot_version()|claim_billing_checkout_session(p_user_id uuid, p_plan text)|create_job_with_storage_quota(p_user_id uuid, p_job_data jsonb, p_storage_status text, p_active_job_limit integer, p_absolute_retained_job_limit integer)|delete_locked_jobs_for_terminal_free_user(p_user_id uuid, p_storage_status text, p_locked_delete_limit integer)|get_job_storage_counts_for_user(p_user_id uuid)|lock_billing_storage_transition()|lock_overflow_jobs_for_terminal_free_user(p_user_id uuid, p_storage_status text, p_active_job_limit integer, p_locked_reason text, p_locked_policy_version text)|merge_stripe_event_receipt(p_event_id text, p_event_type text, p_livemode boolean, p_stripe_event_created timestamp with time zone, p_result text)|resolve_canonical_storage_status_for_user(p_user_id uuid)|restore_locked_jobs_for_premium_user(p_user_id uuid, p_storage_status text, p_absolute_retained_job_limit integer, p_entitled_price_ids text[])|touch_billing_status_changed_at()|touch_billing_updated_at()|upsert_billing_subscription_authoritative(payload jsonb)|upsert_billing_subscription_if_newer_or_equal(payload jsonb)$expected$,
  '31: final public function signatures match exactly'
);

SELECT ok(
  (
    SELECT count(*) = 14
      AND bool_and(NOT p.prosecdef)
      AND bool_and(p.proconfig = ARRAY['search_path=pg_catalog, public']::text[])
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ),
  '32: all public functions are invoker-security with pinned search paths'
);

SELECT is((SELECT array_agg(p.proname ORDER BY p.proname)::text FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')), '{touch_billing_status_changed_at,touch_billing_updated_at}', '33: anon function execution inventory matches');
SELECT is((SELECT array_agg(p.proname ORDER BY p.proname)::text FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')), '{touch_billing_status_changed_at,touch_billing_updated_at}', '34: authenticated function execution inventory matches');
SELECT is((SELECT count(*) FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND has_function_privilege('service_role', p.oid, 'EXECUTE')), 14::bigint, '35: service_role can execute every reviewed public function');
SELECT is(to_regprocedure('public.exec_sql(text)'), NULL::regprocedure, '36: arbitrary-SQL helper is absent');
SELECT is(to_regprocedure('public.restore_locked_jobs_for_premium_user(uuid,text,integer)'), NULL::regprocedure, '37: stale three-argument restore overload is absent');
SELECT ok(to_regprocedure('public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])') IS NOT NULL, '38: reviewed four-argument restore RPC exists');

SELECT is(
  (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass AND conname IN ('jobs_salary_range_check', 'salary_range_valid')),
  'jobs_salary_range_check=CHECK (((salary_min IS NULL) OR (salary_max IS NULL) OR (salary_max >= salary_min)))|salary_range_valid=CHECK (((salary_max >= salary_min) OR (salary_min IS NULL) OR (salary_max IS NULL)))',
  '39: both historical and current jobs salary-range checks are preserved'
);

-- Fixed local-only users make owner-isolation and cascade behavior reproducible.
INSERT INTO auth.users (id)
VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');

INSERT INTO public.user_profiles (user_id, summary, updated_at)
VALUES ('22222222-2222-2222-2222-222222222222', 'profile-b', '2000-01-01 00:00:00+00');

INSERT INTO public.abuse_counters (user_id, strike_type, count)
VALUES ('11111111-1111-1111-1111-111111111111', 'seeded', 1);
INSERT INTO public.daily_spend (date, total_cost_cents)
VALUES ('2099-01-01', 25);

INSERT INTO public.user_profiles (user_id, summary)
VALUES ('33333333-3333-3333-3333-333333333333', 'cascade-profile');
INSERT INTO public.tailor_cache (hash, user_id, response)
VALUES ('cascade-cache', '33333333-3333-3333-3333-333333333333', '{"cascade":true}'::jsonb);
INSERT INTO public.abuse_counters (user_id, strike_type, count)
VALUES ('33333333-3333-3333-3333-333333333333', 'cascade', 1);
INSERT INTO public.jobs (user_id, company, position, status)
VALUES ('33333333-3333-3333-3333-333333333333', 'Cascade Co', 'Tester', 'applied');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

SELECT lives_ok(
  $sql$INSERT INTO public.user_profiles (user_id, summary) VALUES ('11111111-1111-1111-1111-111111111111', 'profile-a')$sql$,
  '40: user_profiles permits an owner insert'
);
SELECT throws_ok(
  $sql$INSERT INTO public.user_profiles (user_id, summary) VALUES ('22222222-2222-2222-2222-222222222222', 'forbidden')$sql$,
  '42501'::character(5),
  NULL,
  '41: user_profiles rejects an insert for another user'
);
SELECT is((SELECT count(*) FROM public.user_profiles), 1::bigint, '42: user_profiles select exposes only the owner row');
SELECT lives_ok(
  $sql$UPDATE public.user_profiles SET summary = 'profile-a-updated' WHERE user_id = '11111111-1111-1111-1111-111111111111'$sql$,
  '43: user_profiles permits an owner update'
);
SELECT lives_ok(
  $sql$UPDATE public.user_profiles SET summary = 'forbidden-update' WHERE user_id = '22222222-2222-2222-2222-222222222222'$sql$,
  '44: user_profiles filters an update targeting another user'
);
SELECT lives_ok(
  $sql$DELETE FROM public.user_profiles WHERE user_id = '11111111-1111-1111-1111-111111111111'$sql$,
  '45: user_profiles permits an owner delete'
);
DELETE FROM public.user_profiles
WHERE user_id = '22222222-2222-2222-2222-222222222222';

RESET ROLE;
SELECT is((SELECT count(*) FROM public.user_profiles WHERE user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, '46: owner profile delete persisted');
SELECT is((SELECT summary FROM public.user_profiles WHERE user_id = '22222222-2222-2222-2222-222222222222'), 'profile-b', '47: cross-user profile update and delete were filtered');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

SELECT lives_ok(
  $sql$INSERT INTO public.tailor_cache (hash, user_id, response) VALUES ('owner-cache', '11111111-1111-1111-1111-111111111111', '{"source":"owner"}'::jsonb)$sql$,
  '48: tailor_cache permits an owner insert'
);
SELECT throws_ok(
  $sql$INSERT INTO public.tailor_cache (hash, user_id, response) VALUES ('other-cache', '22222222-2222-2222-2222-222222222222', '{}'::jsonb)$sql$,
  '42501'::character(5),
  NULL,
  '49: tailor_cache rejects an insert for another user'
);
SELECT is((SELECT count(*) FROM public.tailor_cache), 1::bigint, '50: tailor_cache select exposes only the owner row');
SELECT lives_ok(
  $sql$UPDATE public.tailor_cache SET response = '{"mutated":true}'::jsonb WHERE hash = 'owner-cache'$sql$,
  '51: tailor_cache owner update is safely filtered without an UPDATE policy'
);
DELETE FROM public.tailor_cache WHERE hash = 'owner-cache';

RESET ROLE;
SELECT is((SELECT response FROM public.tailor_cache WHERE hash = 'owner-cache'), '{"source":"owner"}'::jsonb, '52: tailor_cache has no effective owner UPDATE access');
SELECT is((SELECT count(*) FROM public.tailor_cache WHERE hash = 'owner-cache'), 1::bigint, '53: tailor_cache has no effective owner DELETE access');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

SELECT is((SELECT count(*) FROM public.abuse_counters), 0::bigint, '54: abuse_counters is default-deny for authenticated reads');
SELECT is((SELECT count(*) FROM public.daily_spend), 0::bigint, '55: daily_spend is default-deny for authenticated reads');
SELECT throws_ok(
  $sql$INSERT INTO public.abuse_counters (user_id, strike_type) VALUES ('11111111-1111-1111-1111-111111111111', 'blocked')$sql$,
  '42501'::character(5),
  NULL,
  '56: abuse_counters is default-deny for authenticated inserts'
);
SELECT throws_ok(
  $sql$INSERT INTO public.daily_spend (date, total_cost_cents) VALUES ('2099-01-02', 1)$sql$,
  '42501'::character(5),
  NULL,
  '57: daily_spend is default-deny for authenticated inserts'
);
SELECT throws_ok(
  $sql$SELECT * FROM public.jobs$sql$,
  '42501'::character(5),
  NULL,
  '58: authenticated clients have no direct jobs table privilege'
);
SELECT throws_ok(
  $sql$INSERT INTO public.billing_customers (user_id) VALUES ('44444444-4444-4444-4444-444444444444')$sql$,
  '42501'::character(5),
  NULL,
  '59: authenticated clients cannot write service-owned billing tables'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $sql$INSERT INTO public.billing_customers (user_id, stripe_customer_id) VALUES ('44444444-4444-4444-4444-444444444444', 'cus_test_restore')$sql$,
  '60: service_role can create the billing customer fixture'
);
SELECT lives_ok(
  $sql$INSERT INTO public.billing_subscriptions (user_id, stripe_subscription_id, price_id, status, current_period_end) VALUES ('44444444-4444-4444-4444-444444444444', 'sub_test_restore', 'price_premium_allowed', 'active', now() + interval '30 days')$sql$,
  '61: service_role can create the Premium subscription fixture'
);
SELECT lives_ok(
  $sql$INSERT INTO public.jobs (user_id, company, position, status, storage_state, locked_at, locked_reason, locked_policy_version) VALUES ('44444444-4444-4444-4444-444444444444', 'Restore Co', 'Engineer', 'offered', 'locked_over_plan_limit', now(), 'premium_to_free_over_plan_limit', 'baseline-test-v1')$sql$,
  '62: service_role can create a locked restore fixture'
);
SELECT is(
  public.restore_locked_jobs_for_premium_user('44444444-4444-4444-4444-444444444444', 'premium_active', 10, ARRAY['price_wrong']) ->> 'reason',
  'canonical_billing_not_premium',
  '63: four-argument restore rejects a non-allowlisted subscription price'
);
SELECT is((SELECT count(*) FROM public.jobs WHERE user_id = '44444444-4444-4444-4444-444444444444' AND storage_state = 'locked_over_plan_limit'), 1::bigint, '64: rejected restore leaves the job locked');
SELECT is(
  public.restore_locked_jobs_for_premium_user('44444444-4444-4444-4444-444444444444', 'premium_active', 10, ARRAY['price_premium_allowed']) ->> 'restoredCount',
  '1',
  '65: four-argument restore accepts an allowlisted subscription price'
);
SELECT is((SELECT count(*) FROM public.jobs WHERE user_id = '44444444-4444-4444-4444-444444444444' AND storage_state = 'active'), 1::bigint, '66: allowlisted restore clears locked metadata and activates the job');

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
SELECT throws_ok(
  $sql$SELECT public.restore_locked_jobs_for_premium_user('11111111-1111-1111-1111-111111111111', 'premium_active', 10, ARRAY['price_premium_allowed'])$sql$,
  '42501'::character(5),
  NULL,
  '67: authenticated clients cannot execute the Premium restore RPC'
);

RESET ROLE;
UPDATE public.user_profiles
SET summary = 'profile-b-touched'
WHERE user_id = '22222222-2222-2222-2222-222222222222';
SELECT ok((SELECT updated_at > '2000-01-01 00:00:00+00'::timestamptz FROM public.user_profiles WHERE user_id = '22222222-2222-2222-2222-222222222222'), '68: moddatetime advances user_profiles.updated_at');

SELECT lives_ok(
  $sql$DELETE FROM auth.users WHERE id = '33333333-3333-3333-3333-333333333333'$sql$,
  '69: deleting an auth user with only Phase 0 dependents succeeds'
);
SELECT is(
  (SELECT count(*) FROM public.user_profiles WHERE user_id = '33333333-3333-3333-3333-333333333333')
    + (SELECT count(*) FROM public.tailor_cache WHERE user_id = '33333333-3333-3333-3333-333333333333')
    + (SELECT count(*) FROM public.abuse_counters WHERE user_id = '33333333-3333-3333-3333-333333333333')
    + (SELECT count(*) FROM public.jobs WHERE user_id = '33333333-3333-3333-3333-333333333333'),
  0::bigint,
  '70: Phase 0 user-owned rows cascade on auth user deletion'
);
SELECT throws_ok(
  $sql$DELETE FROM auth.users WHERE id = '44444444-4444-4444-4444-444444444444'$sql$,
  '23503'::character(5),
  NULL,
  '71: billing foreign keys restrict auth user deletion'
);

SELECT * FROM finish();
ROLLBACK;
