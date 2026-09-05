-- Why did the database refuse this row?
--
-- Run this in the Supabase SQL editor for the project the browser is signed in
-- to. It reports the four things that can produce
--
--   new row violates row-level security policy for table "projects"  (42501)
--
-- while `projects_insert_owner` is present and its expression looks correct.
-- Checking only the policy name and its USING/WITH CHECK expression is not
-- enough: the role the policy applies to, its permissiveness, policies written
-- FOR ALL, and BEFORE INSERT triggers are all invisible in that view.
--
-- Nothing here writes. It is safe to run against production.

-- 1. Every policy on the table, including the columns usually left out.
--    `roles` must contain `authenticated` for the insert policy, and
--    `permissive` must be PERMISSIVE. A RESTRICTIVE policy that fails is named
--    in the error message, so if your error carries no policy name, that is
--    already ruled out.
select
  polname                                   as policy,
  case polcmd
    when 'r' then 'SELECT' when 'a' then 'INSERT'
    when 'w' then 'UPDATE' when 'd' then 'DELETE' when '*' then 'ALL'
  end                                       as command,
  case when polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as permissive,
  coalesce(
    (select string_agg(rolname, ', ') from pg_roles where oid = any (polroles)),
    'PUBLIC'
  )                                         as roles,
  pg_get_expr(polqual, polrelid)            as using_expr,
  pg_get_expr(polwithcheck, polrelid)       as with_check
from pg_policy
where polrelid = 'public.projects'::regclass
order by polcmd, polname;

-- 2. Row level security must be on, and must not be forced in a way that also
--    applies to the table owner.
select relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where oid = 'public.projects'::regclass;

-- 3. Any trigger that fires before an insert can rewrite owner_id after the
--    client sent it and before the policy is evaluated. Forge's own triggers
--    are all BEFORE UPDATE; anything here firing on INSERT is not ours.
select tgname as trigger_name,
       case when tgtype & 4 = 4 then 'INSERT'
            when tgtype & 16 = 16 then 'UPDATE'
            when tgtype & 8 = 8 then 'DELETE' else 'other' end as fires_on,
       case when tgtype & 2 = 2 then 'BEFORE' else 'AFTER' end as timing,
       pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.projects'::regclass and not tgisinternal;

-- 4. Who the database thinks you are. Run this from the browser session, not
--    the SQL editor: the editor connects as the table owner and will show
--    NULL here even when everything is fine.
--
--    In the browser console on a signed-in Forge tab:
--
--      const { data } = await window.supabase.auth.getSession();
--      console.log('session user', data.session?.user?.id);
--
--    That uuid must equal the owner_id the insert carries, and must exist in
--    public.profiles. To confirm the profile side from here:
select id, email from public.profiles order by created_at desc limit 5;

-- 5. Confirm this is the project the browser is talking to. The ref in the
--    browser's Supabase URL must match this database.
select current_database() as database, current_setting('server_version') as version;
