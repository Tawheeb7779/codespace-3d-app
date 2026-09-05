-- Let a project's own creator read the row back.
--
-- Creating a project failed with
--
--   new row violates row-level security policy for table "projects"  (42501)
--
-- on a database where every check passed: `projects_insert_owner` present,
-- PERMISSIVE, TO authenticated, WITH CHECK (owner_id = auth.uid()); the
-- authenticated role holding INSERT; no BEFORE INSERT trigger; auth.uid()
-- reading request.jwt.claims correctly; and owner_id equal to the session's
-- user id.
--
-- All of that was true, and irrelevant. The insert policy was never the one
-- refusing. PostgreSQL applies the SELECT policy as an additional WITH CHECK
-- against rows produced by a RETURNING clause, and the client asks for one:
-- PostgREST sends `Prefer: return=representation` whenever a caller chains
-- `.select()` onto an insert, which is how the row's timestamps come back.
--
-- `projects_select_readable` is `using (can_read_project(id))`, and that
-- function — like `project_role` beneath it — answers by looking the project up
-- in `public.projects`. Both are STABLE, so both read the statement's snapshot,
-- and the row being inserted is not in it. The lookup finds nothing, the policy
-- evaluates false, and the insert is refused.
--
-- Reproduced exactly, same session, same policies, only the statement differing:
--
--   INSERT (no RETURNING)      -> INSERT 0 1
--   INSERT ... RETURNING id    -> new row violates row-level security policy
--
-- The fix is to let the policy answer from the row in front of it instead of
-- going back to the table for it. `owner_id = auth.uid()` is exactly what
-- `project_role` already returns 'owner' for, so for every row that exists this
-- changes nothing at all; it only decides the case where the row is not yet
-- visible to the snapshot, which is the one that was broken. Nobody gains
-- access to a project they could not already read.

drop policy if exists projects_select_readable on public.projects;
create policy projects_select_readable on public.projects
  for select to authenticated
  using (
    -- Answerable from the row itself, so it also holds for a row this
    -- statement is still creating.
    owner_id = auth.uid()
    -- Everything else — membership, team access, public visibility — needs the
    -- lookup, and by then the row is committed and visible.
    or public.can_read_project(id)
  );

-- Verify the end state rather than assume it.
do $$
declare
  predicate text;
begin
  select pg_get_expr(polqual, polrelid) into predicate
    from pg_policy
   where polrelid = 'public.projects'::regclass and polname = 'projects_select_readable';

  if predicate is null then
    raise exception 'projects_select_readable is missing';
  end if;
  if predicate not like '%owner_id%' or predicate not like '%can_read_project%' then
    raise exception 'projects_select_readable lost one of its two arms: %', predicate;
  end if;
  if not exists (
    select 1 from pg_class where oid = 'public.projects'::regclass and relrowsecurity
  ) then
    raise exception 'row level security is not enabled on public.projects';
  end if;

  raise notice 'projects_select_readable now reads: %', predicate;
end $$;
