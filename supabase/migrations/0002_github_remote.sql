-- Forge IDE — GitHub remote integration.
--
-- Two concerns, deliberately stored apart:
--
--   * `private.github_tokens` holds the credential. It lives in a schema that
--     `anon` and `authenticated` have no rights on at all, so PostgREST cannot
--     reach it under any policy, role or query. Only the service role — which
--     is the Edge Functions and nothing that runs in a browser — can read it.
--     There is no policy on it because there is no client path to it.
--
--   * `public.github_connections` holds the *status* of a connection: which
--     GitHub login, which scopes, when it was granted. That is safe for the
--     owning user to read, and is what the UI renders.
--
-- Project-level remote metadata sits in `public.project_remotes`, guarded so
-- that a viewer cannot change where a project points and an editor cannot
-- silently repoint it at a repository the project was never connected to.

-- ---------------------------------------------------------------------------
-- Credential storage, out of reach of the client
-- ---------------------------------------------------------------------------

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.github_tokens (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  access_token  text        not null,
  refresh_token text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Belt and braces: even if a future grant leaked the schema, RLS with no
-- policy denies every row to every non-superuser role.
alter table private.github_tokens enable row level security;
alter table private.github_tokens force row level security;

revoke all on private.github_tokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Connection status, readable by its owner
-- ---------------------------------------------------------------------------

create table if not exists public.github_connections (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  github_login   text        not null,
  github_user_id bigint      not null,
  avatar_url     text,
  scopes         text[]      not null default '{}',
  connected_at   timestamptz not null default now(),
  -- Set when GitHub last told us the grant is gone, so the UI can say so
  -- instead of failing every call with a bare 401.
  revoked_at     timestamptz,
  constraint github_connections_login_format
    check (github_login ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$')
);

create index if not exists github_connections_login_idx
  on public.github_connections (github_login);

-- ---------------------------------------------------------------------------
-- OAuth state, so a callback cannot be replayed or cross-linked
-- ---------------------------------------------------------------------------

create table if not exists private.github_oauth_states (
  state      text primary key,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  redirect   text        not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

alter table private.github_oauth_states enable row level security;
alter table private.github_oauth_states force row level security;
revoke all on private.github_oauth_states from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Per-project remote
-- ---------------------------------------------------------------------------

do $$ begin
  create type remote_provider as enum ('github');
exception when duplicate_object then null; end $$;

create table if not exists public.project_remotes (
  project_id      text            primary key references public.projects (id) on delete cascade,
  provider        remote_provider not null default 'github',
  owner           text            not null,
  repo            text            not null,
  repo_id         bigint          not null,
  default_branch  text            not null,
  branch          text            not null,
  last_fetched_sha text,
  last_synced_sha  text,
  last_fetched_at  timestamptz,
  -- Local bookkeeping the client needs to plan a pull: the tree we last shared
  -- with the remote, and which local commit became which git SHA. It is not
  -- shared configuration, so it is not modelled as columns.
  tracking        jsonb           not null default '{}'::jsonb,
  connected_by    uuid            references public.profiles (id) on delete set null,
  created_at      timestamptz     not null default now(),
  updated_at      timestamptz     not null default now(),
  -- The same identifier rules the client and the proxy enforce, restated
  -- where they are authoritative. An owner or repo name reaches a GitHub API
  -- path, so `..` in one is a traversal primitive.
  constraint project_remotes_owner_format
    check (owner ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
  constraint project_remotes_repo_format
    check (repo ~ '^[A-Za-z0-9._-]{1,100}$' and repo not in ('.', '..')),
  constraint project_remotes_branch_format
    check (
      char_length(branch) between 1 and 255
      and branch !~ '\.\.'
      and branch !~ '^[-/]'
      and branch !~ '[/.]$'
      and branch !~ '[[:cntrl:] ~^:?*\[\\]'
    ),
  constraint project_remotes_default_branch_format
    check (char_length(default_branch) between 1 and 255 and default_branch !~ '\.\.'),
  constraint project_remotes_fetched_sha_format
    check (last_fetched_sha is null or last_fetched_sha ~ '^[0-9a-f]{40}$'),
  constraint project_remotes_synced_sha_format
    check (last_synced_sha is null or last_synced_sha ~ '^[0-9a-f]{40}$')
);

create index if not exists project_remotes_repo_idx
  on public.project_remotes (owner, repo);
create index if not exists project_remotes_connected_by_idx
  on public.project_remotes (connected_by);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.github_connections enable row level security;
alter table public.project_remotes    enable row level security;

-- A GitHub connection belongs to exactly one user and is never shared. There
-- is deliberately no policy letting a project admin read a collaborator's
-- connection: knowing which GitHub account someone linked is theirs to share.
drop policy if exists github_connections_select_self on public.github_connections;
create policy github_connections_select_self on public.github_connections
  for select to authenticated using (user_id = auth.uid());

drop policy if exists github_connections_delete_self on public.github_connections;
create policy github_connections_delete_self on public.github_connections
  for delete to authenticated using (user_id = auth.uid());

-- Rows are written by the Edge Function under the service role, which is not
-- subject to these policies. No insert or update policy exists for
-- `authenticated`: a browser cannot claim a GitHub identity it did not earn
-- through the OAuth exchange.

-- Membership, not readability. `can_read_project` is also true for anyone
-- browsing a *public* project, and a public Forge project may well be
-- connected to a private GitHub repository — publishing the owner and name of
-- that repository to every signed-in visitor would leak its existence.
drop policy if exists project_remotes_select on public.project_remotes;
create policy project_remotes_select on public.project_remotes
  for select to authenticated using (public.project_role(project_id) is not null);

-- Connecting a repository, or disconnecting one, is a project setting.
drop policy if exists project_remotes_insert_admin on public.project_remotes;
create policy project_remotes_insert_admin on public.project_remotes
  for insert to authenticated with check (public.can_administer_project(project_id));

drop policy if exists project_remotes_delete_admin on public.project_remotes;
create policy project_remotes_delete_admin on public.project_remotes
  for delete to authenticated using (public.can_administer_project(project_id));

-- Recording the result of a fetch, pull or push is ordinary write work, so an
-- editor may update the tracking columns. The trigger below stops an editor
-- from using that same update to repoint the project somewhere else.
drop policy if exists project_remotes_update_editor on public.project_remotes;
create policy project_remotes_update_editor on public.project_remotes
  for update to authenticated
  using (public.can_write_project(project_id))
  with check (public.can_write_project(project_id));

create or replace function public.guard_remote_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (
    new.provider       is distinct from old.provider
    or new.owner       is distinct from old.owner
    or new.repo        is distinct from old.repo
    or new.repo_id     is distinct from old.repo_id
    or new.default_branch is distinct from old.default_branch
  ) and not public.can_administer_project(new.project_id) then
    raise exception 'changing the connected repository requires the admin role'
      using errcode = 'insufficient_privilege';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_remotes_guard_identity on public.project_remotes;
create trigger project_remotes_guard_identity before update on public.project_remotes
  for each row execute function public.guard_remote_identity();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select, delete on public.github_connections to authenticated;
grant select, insert, update, delete on public.project_remotes to authenticated;

revoke all on public.github_connections from anon;
revoke all on public.project_remotes    from anon;
revoke all on all tables in schema private from anon, authenticated;
