-- Why did the database refuse this row?
--
-- Run this in the Supabase SQL editor for the project the browser is signed in
-- to. Nothing here writes; it is safe against production.
--
-- It exists because checking only that `projects_insert_owner` is present is
-- not enough. Verified against a real PostgreSQL with that policy in place and
-- its expression correct, four different situations still produce
--
--   new row violates row-level security policy for table "projects"  (42501)
--
--   * owner_id is not the caller
--   * the session carries no subject, so auth.uid() is null
--   * the policy applies to a role the caller is not using
--   * a BEFORE INSERT trigger rewrites owner_id before the check runs
--
-- A RESTRICTIVE policy is the one cause that reads differently: Postgres names
-- the offending policy in the message. An unnamed refusal rules it out.

-- ===========================================================================
-- 1. The verdict, in one row per check.
-- ===========================================================================
with insert_policy as (
  select
    polname,
    polpermissive,
    coalesce((select string_agg(rolname, ', ' order by rolname)
                from pg_roles where oid = any (polroles)), 'PUBLIC') as roles,
    pg_get_expr(polwithcheck, polrelid) as with_check
  from pg_policy
  where polrelid = 'public.projects'::regclass and polcmd in ('a', '*')
),
checks(ordinal, check_name, verdict, evidence) as (
  values
  (1, 'INSERT policy exists',
      (select case when count(*) > 0 then 'PASS' else 'FAIL' end from insert_policy),
      (select coalesce(string_agg(polname, ', '), '(none)') from insert_policy)),

  (2, 'applies TO authenticated',
      (select case when bool_or(roles like '%authenticated%' or roles = 'PUBLIC')
                   then 'PASS' else 'FAIL' end from insert_policy),
      (select coalesce(string_agg(polname || ' -> ' || roles, '; '), '(none)') from insert_policy)),

  (3, 'is PERMISSIVE, not RESTRICTIVE',
      (select case when bool_and(polpermissive) then 'PASS' else 'FAIL' end from insert_policy),
      (select coalesce(string_agg(polname || ' -> ' ||
              case when polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end, '; '), '(none)')
         from insert_policy)),

  (4, 'ties the row to the caller',
      (select case when bool_or(with_check like '%auth.uid()%' and with_check like '%owner_id%')
                   then 'PASS' else 'FAIL' end from insert_policy),
      (select coalesce(string_agg(coalesce(with_check, '(null)'), '; '), '(none)') from insert_policy)),

  (5, 'row level security is enabled',
      (select case when relrowsecurity then 'PASS' else 'FAIL' end
         from pg_class where oid = 'public.projects'::regclass),
      (select 'enabled=' || relrowsecurity || ' forced=' || relforcerowsecurity
         from pg_class where oid = 'public.projects'::regclass)),

  (6, 'no BEFORE INSERT trigger rewrites the row',
      (select case when count(*) = 0 then 'PASS' else 'FAIL' end
         from pg_trigger where tgrelid = 'public.projects'::regclass
          and not tgisinternal and tgtype & 4 = 4 and tgtype & 2 = 2),
      (select coalesce(string_agg(tgname, ', '), '(none)')
         from pg_trigger where tgrelid = 'public.projects'::regclass
          and not tgisinternal and tgtype & 4 = 4 and tgtype & 2 = 2)),

  (7, 'anon holds no privilege on projects',
      (select case when count(*) = 0 then 'PASS' else 'FAIL' end
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'projects' and grantee = 'anon'),
      (select coalesce(string_agg(privilege_type, ',' order by privilege_type), '(none)')
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'projects' and grantee = 'anon')),

  (8, 'authenticated may insert',
      (select case when count(*) > 0 then 'PASS' else 'FAIL' end
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'projects'
          and grantee = 'authenticated' and privilege_type = 'INSERT'),
      (select coalesce(string_agg(privilege_type, ',' order by privilege_type), '(none)')
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'projects' and grantee = 'authenticated')),

  (9, 'migration 0005 is applied (writer update policy)',
      (select case when count(*) > 0 then 'PASS' else 'FAIL' end from pg_policy
        where polrelid = 'public.projects'::regclass and polname = 'projects_update_writer'),
      'projects_update_writer'),

  (10, 'the profile row for the signing-in account exists',
      'INFO',
      'replace the uuid below and re-run section 3')
)
select ordinal, check_name, verdict, evidence from checks order by ordinal;

-- ===========================================================================
-- 2. Every policy on the table, in full.
-- ===========================================================================
select
  polname as policy,
  case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
              when 'w' then 'UPDATE' when 'd' then 'DELETE' when '*' then 'ALL' end as command,
  case when polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as permissive,
  coalesce((select string_agg(rolname, ', ') from pg_roles where oid = any (polroles)), 'PUBLIC') as roles,
  pg_get_expr(polqual, polrelid) as using_expr,
  pg_get_expr(polwithcheck, polrelid) as with_check
from pg_policy
where polrelid = 'public.projects'::regclass
order by polcmd, polname;

-- Every trigger, with its definition.
select tgname as trigger_name,
       case when tgtype & 2 = 2 then 'BEFORE' else 'AFTER' end as timing,
       case when tgtype & 4 = 4 then 'INSERT'
            when tgtype & 16 = 16 then 'UPDATE'
            when tgtype & 8 = 8 then 'DELETE' else 'other' end as event,
       pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.projects'::regclass and not tgisinternal;

-- ===========================================================================
-- 3. The account. Replace the uuid with the one the browser reported.
-- ===========================================================================
select exists (
  select 1 from public.profiles where id = '00000000-0000-0000-0000-000000000000'
) as profile_exists,
exists (
  select 1 from auth.users where id = '00000000-0000-0000-0000-000000000000'
) as auth_user_exists;

-- ===========================================================================
-- 4. Which project this database is. The ref here must match the ref in the
--    browser's Supabase URL; if it does not, the browser is talking to a
--    different database than the one these results describe.
-- ===========================================================================
select current_database() as database,
       coalesce(current_setting('app.settings.jwt_iss', true), '(not set)') as jwt_issuer;
