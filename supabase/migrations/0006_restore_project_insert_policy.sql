-- Restore the insert authorization for public.projects.
--
-- A deployed project was found with row level security enabled on
-- `public.projects` but without `projects_insert_owner`, the policy 0001
-- defines. With RLS on and no policy admitting the statement, Postgres refuses
-- every insert:
--
--   new row violates row-level security policy for table "projects"  (42501)
--
-- which is what Cloud Mode reported when creating a project. Reproduced
-- against a real PostgreSQL: with the policy present the client's exact
-- payload inserts, with it dropped that sentence comes back verbatim.
--
-- 0001 is safely re-runnable — every policy there is guarded by a matching
-- `drop policy if exists`, tables use `if not exists`, functions and triggers
-- are replaced rather than added, and no migration in this directory contains
-- a DROP TABLE, TRUNCATE, DELETE or column-type change. Re-running it would
-- therefore have been sound. This file exists so a live database does not have
-- to be handed five hundred lines to repair one policy: it restores that one
-- policy and the grant it rests on, and nothing else.
--
-- Nothing here is new or more permissive. The predicate is copied from 0001
-- unchanged, and the checks at the bottom refuse to let the migration report
-- success unless the intended boundary actually holds afterwards.

-- Row level security stays on. Asserted rather than set, so this migration can
-- never be the thing that turns it off.
do $$
begin
  if not exists (
    select 1 from pg_class
     where oid = 'public.projects'::regclass and relrowsecurity
  ) then
    raise exception 'row level security is disabled on public.projects; refusing to add a policy that would look like protection';
  end if;
end $$;

-- The policy, exactly as 0001_init.sql defines it.
drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner on public.projects
  for insert to authenticated with check (owner_id = auth.uid());

-- The grant the policy rests on. A policy admits a statement; the grant is
-- what lets the role reach the table at all, and 0001 issues this same line.
-- `anon` is deliberately absent here and revoked below.
grant insert on public.projects to authenticated;

-- `anon` never inserts. Re-asserted because this migration exists precisely
-- because a deployment drifted from what the repository says.
revoke all on public.projects from anon;

-- Verify the end state rather than assume it.
do $$
declare
  predicate text;
begin
  select pg_get_expr(polwithcheck, polrelid) into predicate
    from pg_policy
   where polrelid = 'public.projects'::regclass
     and polname = 'projects_insert_owner';

  if predicate is null then
    raise exception 'projects_insert_owner was not created';
  end if;
  if predicate not like '%auth.uid()%' or predicate not like '%owner_id%' then
    raise exception 'projects_insert_owner does not tie the row to the caller: %', predicate;
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'projects' and grantee = 'anon'
  ) then
    raise exception 'anon still holds a privilege on public.projects';
  end if;

  raise notice 'projects_insert_owner restored: %', predicate;
end $$;
