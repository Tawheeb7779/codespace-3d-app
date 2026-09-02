-- Forge IDE — initial schema.
--
-- Design notes
--   * Every table has row level security enabled with explicit per-operation
--     policies. There is no "authenticated users can do anything" policy
--     anywhere; access always resolves through ownership or membership.
--   * Membership lookups go through SECURITY DEFINER helper functions. This is
--     deliberate: a policy on `projects` that reads `project_members`, whose own
--     policy reads `projects`, would recurse. The helpers break that cycle and
--     are the only place that bypasses RLS.
--   * Roles are ordered viewer < editor < admin < owner. Writes need editor or
--     above; membership changes need admin or above; deletion is owner only.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type member_role as enum ('viewer', 'editor', 'admin', 'owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_visibility as enum ('private', 'team', 'public');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_status as enum ('draft', 'active', 'archived');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text        not null,
  display_name text        not null default 'Developer',
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 80)
);

comment on table public.profiles is 'Public profile mirrored from auth.users.';

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------

create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  owner_id   uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint teams_name_length check (char_length(name) between 1 and 80),
  constraint teams_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$')
);

create table if not exists public.team_members (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid        not null references public.teams (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  role       member_role not null default 'editor',
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);

create index if not exists team_members_user_idx on public.team_members (user_id);
create index if not exists team_members_team_idx on public.team_members (team_id);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id          text primary key,
  owner_id    uuid               not null references public.profiles (id) on delete cascade,
  team_id     uuid               references public.teams (id) on delete set null,
  name        text               not null,
  description text               not null default '',
  template    text               not null default 'blank',
  language    text               not null default 'Plain Text',
  visibility  project_visibility not null default 'private',
  status      project_status     not null default 'active',
  starred     boolean            not null default false,
  dirs        text[]             not null default '{}',
  created_at  timestamptz        not null default now(),
  updated_at  timestamptz        not null default now(),
  constraint projects_name_length check (char_length(name) between 1 and 60),
  constraint projects_description_length check (char_length(description) <= 280),
  constraint projects_id_format check (id ~ '^[A-Za-z0-9_-]{6,64}$')
);

create index if not exists projects_owner_idx on public.projects (owner_id, updated_at desc);
create index if not exists projects_team_idx on public.projects (team_id);
create index if not exists projects_visibility_idx on public.projects (visibility)
  where visibility = 'public';

create table if not exists public.project_members (
  id         uuid primary key default gen_random_uuid(),
  project_id text        not null references public.projects (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  role       member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index if not exists project_members_user_idx on public.project_members (user_id);
create index if not exists project_members_project_idx on public.project_members (project_id);

create table if not exists public.project_files (
  id         uuid primary key default gen_random_uuid(),
  project_id text        not null references public.projects (id) on delete cascade,
  path       text        not null,
  content    text        not null default '',
  updated_at timestamptz not null default now(),
  unique (project_id, path),
  -- The same path policy the client enforces, restated where it is authoritative.
  constraint project_files_path_relative check (path !~ '(^|/)\.\.(/|$)'),
  constraint project_files_path_no_leading_slash check (path !~ '^/'),
  constraint project_files_path_length check (char_length(path) between 1 and 400),
  constraint project_files_size check (octet_length(content) <= 2097152)
);

create index if not exists project_files_project_idx on public.project_files (project_id);

create table if not exists public.project_settings (
  project_id text primary key references public.projects (id) on delete cascade,
  settings   jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.project_vcs (
  project_id text primary key references public.projects (id) on delete cascade,
  snapshot   jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.project_activity (
  id         uuid primary key default gen_random_uuid(),
  project_id text        not null references public.projects (id) on delete cascade,
  actor_id   uuid        references public.profiles (id) on delete set null,
  action     text        not null,
  detail     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint project_activity_action_length check (char_length(action) between 1 and 60)
);

create index if not exists project_activity_project_idx
  on public.project_activity (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Helper functions
--
-- SECURITY DEFINER so a policy can consult membership without triggering the
-- membership table's own policies. `search_path` is pinned to defeat search
-- path hijacking, and each function is a pure read.
-- ---------------------------------------------------------------------------

create or replace function public.project_role(target_project text)
returns member_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (
      select 1 from public.projects p
      where p.id = target_project and p.owner_id = auth.uid()
    ) then 'owner'::member_role
    else (
      select coalesce(
        (select pm.role from public.project_members pm
          where pm.project_id = target_project and pm.user_id = auth.uid()),
        (select tm.role from public.projects p
           join public.team_members tm on tm.team_id = p.team_id
          where p.id = target_project and tm.user_id = auth.uid())
      )
    )
  end;
$$;

create or replace function public.role_at_least(actual member_role, minimum member_role)
returns boolean
language sql
immutable
as $$
  select case actual
    when 'owner'  then 4
    when 'admin'  then 3
    when 'editor' then 2
    when 'viewer' then 1
    else 0
  end >= case minimum
    when 'owner'  then 4
    when 'admin'  then 3
    when 'editor' then 2
    when 'viewer' then 1
    else 0
  end;
$$;

create or replace function public.can_read_project(target_project text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    exists (
      select 1 from public.projects p
      where p.id = target_project and p.visibility = 'public'
    )
    or public.project_role(target_project) is not null;
$$;

create or replace function public.can_write_project(target_project text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Public visibility grants reading only; writing always needs a role.
  select public.role_at_least(coalesce(public.project_role(target_project), 'viewer'), 'editor')
     and public.project_role(target_project) is not null;
$$;

create or replace function public.can_administer_project(target_project text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.project_role(target_project) is not null
     and public.role_at_least(public.project_role(target_project), 'admin');
$$;

create or replace function public.owns_project(target_project text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project and p.owner_id = auth.uid()
  );
$$;

create or replace function public.team_role(target_team uuid)
returns member_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (select 1 from public.teams t where t.id = target_team and t.owner_id = auth.uid())
      then 'owner'::member_role
    else (select tm.role from public.team_members tm
           where tm.team_id = target_team and tm.user_id = auth.uid())
  end;
$$;

-- Keep updated_at honest instead of trusting whatever the client sends.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists project_files_touch on public.project_files;
create trigger project_files_touch before update on public.project_files
  for each row execute function public.touch_updated_at();

-- Mirror new auth users into profiles.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(coalesce(new.email, 'developer@local'), '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles         enable row level security;
alter table public.teams            enable row level security;
alter table public.team_members     enable row level security;
alter table public.projects         enable row level security;
alter table public.project_members  enable row level security;
alter table public.project_files    enable row level security;
alter table public.project_settings enable row level security;
alter table public.project_vcs      enable row level security;
alter table public.project_activity enable row level security;

-- Profiles ------------------------------------------------------------------

drop policy if exists profiles_select_self_or_shared on public.profiles;
create policy profiles_select_self_or_shared on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    -- Collaborators can see each other, nobody else.
    or exists (
      select 1
        from public.project_members mine
        join public.project_members theirs on theirs.project_id = mine.project_id
       where mine.user_id = auth.uid() and theirs.user_id = profiles.id
    )
    or exists (
      select 1
        from public.team_members mine
        join public.team_members theirs on theirs.team_id = mine.team_id
       where mine.user_id = auth.uid() and theirs.user_id = profiles.id
    )
  );

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- No delete policy: profiles disappear with the auth user.

-- Teams ---------------------------------------------------------------------

drop policy if exists teams_select_members on public.teams;
create policy teams_select_members on public.teams
  for select to authenticated using (public.team_role(id) is not null);

drop policy if exists teams_insert_self_owned on public.teams;
create policy teams_insert_self_owned on public.teams
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists teams_update_admin on public.teams;
create policy teams_update_admin on public.teams
  for update to authenticated
  using (public.role_at_least(coalesce(public.team_role(id), 'viewer'), 'admin'))
  with check (owner_id = auth.uid());

drop policy if exists teams_delete_owner on public.teams;
create policy teams_delete_owner on public.teams
  for delete to authenticated using (owner_id = auth.uid());

drop policy if exists team_members_select on public.team_members;
create policy team_members_select on public.team_members
  for select to authenticated using (public.team_role(team_id) is not null);

drop policy if exists team_members_write_admin on public.team_members;
create policy team_members_write_admin on public.team_members
  for all to authenticated
  using (public.role_at_least(coalesce(public.team_role(team_id), 'viewer'), 'admin'))
  with check (public.role_at_least(coalesce(public.team_role(team_id), 'viewer'), 'admin'));

-- Projects ------------------------------------------------------------------

drop policy if exists projects_select_readable on public.projects;
create policy projects_select_readable on public.projects
  for select to authenticated using (public.can_read_project(id));

drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner on public.projects
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists projects_update_admin on public.projects;
create policy projects_update_admin on public.projects
  for update to authenticated
  using (public.can_administer_project(id))
  with check (public.can_administer_project(id));

-- Ownership transfer is guarded by a trigger rather than a policy predicate: a
-- WITH CHECK sub-select against `projects` would re-enter this same policy.
create or replace function public.guard_owner_transfer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.owner_id is distinct from old.owner_id and old.owner_id <> auth.uid() then
    raise exception 'only the current owner may transfer ownership'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_guard_owner on public.projects;
create trigger projects_guard_owner before update on public.projects
  for each row execute function public.guard_owner_transfer();

drop policy if exists projects_delete_owner on public.projects;
create policy projects_delete_owner on public.projects
  for delete to authenticated using (owner_id = auth.uid());

drop policy if exists project_members_select on public.project_members;
create policy project_members_select on public.project_members
  for select to authenticated using (public.can_read_project(project_id));

drop policy if exists project_members_write_admin on public.project_members;
create policy project_members_write_admin on public.project_members
  for all to authenticated
  using (public.can_administer_project(project_id))
  -- Only the owner may hand out the owner role, and never to themselves twice.
  with check (
    public.can_administer_project(project_id)
    and (role <> 'owner' or public.owns_project(project_id))
  );

-- Project content -----------------------------------------------------------

drop policy if exists project_files_select on public.project_files;
create policy project_files_select on public.project_files
  for select to authenticated using (public.can_read_project(project_id));

drop policy if exists project_files_write on public.project_files;
create policy project_files_write on public.project_files
  for all to authenticated
  using (public.can_write_project(project_id))
  with check (public.can_write_project(project_id));

drop policy if exists project_settings_select on public.project_settings;
create policy project_settings_select on public.project_settings
  for select to authenticated using (public.can_read_project(project_id));

drop policy if exists project_settings_write on public.project_settings;
create policy project_settings_write on public.project_settings
  for all to authenticated
  using (public.can_administer_project(project_id))
  with check (public.can_administer_project(project_id));

drop policy if exists project_vcs_select on public.project_vcs;
create policy project_vcs_select on public.project_vcs
  for select to authenticated using (public.can_read_project(project_id));

drop policy if exists project_vcs_write on public.project_vcs;
create policy project_vcs_write on public.project_vcs
  for all to authenticated
  using (public.can_write_project(project_id))
  with check (public.can_write_project(project_id));

drop policy if exists project_activity_select on public.project_activity;
create policy project_activity_select on public.project_activity
  for select to authenticated using (public.can_read_project(project_id));

drop policy if exists project_activity_insert on public.project_activity;
create policy project_activity_insert on public.project_activity
  for insert to authenticated
  -- An actor may only file activity under their own identity.
  with check (public.can_write_project(project_id) and actor_id = auth.uid());

-- Activity is an append-only audit trail: no update or delete policy exists.

-- ---------------------------------------------------------------------------
-- Grants
--
-- RLS is the authorization boundary; these grants only make the tables
-- reachable. `anon` gets nothing: every read requires a session.
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles, public.teams, public.team_members, public.projects,
  public.project_members, public.project_files, public.project_settings,
  public.project_vcs
  to authenticated;
grant select, insert on public.project_activity to authenticated;

revoke all on all tables in schema public from anon;
