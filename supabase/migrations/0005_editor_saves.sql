-- Let a project editor save the working tree.
--
-- `projects` had one update policy, and it required the administrator role.
-- But saving files also writes `projects.dirs` and `projects.updated_at`: the
-- directory list is part of the working tree, and the timestamp is what orders
-- the dashboard. An editor's save therefore matched no row, PostgREST reported
-- no error for an update that touched nothing, and the application called it a
-- success. New folders quietly failed to persist and deleted ones came back.
--
-- The shape here is: a second policy admits writers, and a trigger holds the
-- administrative columns still for anyone who is not an administrator. Policies
-- are OR'ed, so an administrator still passes through the original one and the
-- trigger lets them through untouched.

-- Ordering matters: the guard must exist before the policy that lets a writer
-- reach these rows.
create or replace function public.guard_project_admin_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- No JWT means this is not a browser session: the service role, a migration,
  -- or another trigger. Row level security does not apply to those, so neither
  -- does this guard — it exists to constrain a user who reached the row
  -- through the writer policy below.
  if auth.uid() is null then
    return new;
  end if;
  if public.can_administer_project(new.id) then
    return new;
  end if;
  -- A writer may change the working tree and nothing else. `language` is
  -- derived from the file extensions in that tree, so it moves with it.
  if new.id          is distinct from old.id
  or new.owner_id    is distinct from old.owner_id
  or new.team_id     is distinct from old.team_id
  or new.name        is distinct from old.name
  or new.description is distinct from old.description
  or new.template    is distinct from old.template
  or new.visibility  is distinct from old.visibility
  or new.status      is distinct from old.status
  or new.starred     is distinct from old.starred
  or new.created_at  is distinct from old.created_at then
    raise exception 'only a project administrator may change that setting'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_guard_admin_columns on public.projects;
create trigger projects_guard_admin_columns before update on public.projects
  for each row execute function public.guard_project_admin_columns();

drop policy if exists projects_update_writer on public.projects;
create policy projects_update_writer on public.projects
  for update to authenticated
  using (public.can_write_project(id))
  with check (public.can_write_project(id));
