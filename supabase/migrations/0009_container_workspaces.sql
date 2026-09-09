-- TA CODE — container workspace metadata.
--
-- Deliberately not a process registry. The gateway's in-memory state and the
-- container runtime are the authority on what is *running*; a row here that
-- says a container exists proves nothing, because the host it was on can be
-- replaced between one request and the next. The gateway re-checks with the
-- runtime before handing a workspace to anybody, and this table is never
-- consulted to decide whether a shell may attach.
--
-- What it is for is the questions a database answers well and a process cannot:
-- who has used a workspace, on which project, when they last did, and at which
-- tier. Support and billing need that after the container is long gone.
--
-- The gateway writes these rows with the service role. There is no insert,
-- update or delete policy for `authenticated`, so a user cannot invent a
-- workspace, extend one, or erase the record of one.

create table if not exists public.container_workspaces (
  id              text        primary key,
  user_id         uuid        not null references auth.users (id) on delete cascade,
  project_id      text        not null references public.projects (id) on delete cascade,
  -- Mirrors the protocol's lifecycle vocabulary, so a support query and the
  -- gateway's logs use the same words.
  status          text        not null default 'creating',
  tier            text        not null default 'free',
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now(),
  stopped_at      timestamptz,
  -- Why it ended, for the ordinary question "where did my container go".
  stopped_reason  text,
  constraint container_workspaces_status_known
    check (status in ('creating', 'starting', 'ready', 'stopping', 'stopped', 'error', 'expired')),
  constraint container_workspaces_tier_known check (tier in ('free', 'pro')),
  constraint container_workspaces_id_shape check (id ~ '^[A-Za-z0-9_-]{1,128}$')
);

-- The two queries this serves: one user's workspaces, and the reaper's sweep of
-- rows that outlived their containers.
create index if not exists container_workspaces_user_idx
  on public.container_workspaces (user_id, last_active_at desc);
create index if not exists container_workspaces_active_idx
  on public.container_workspaces (status, last_active_at desc);

alter table public.container_workspaces enable row level security;

-- Readable by the person it belongs to, and by nobody else: which projects
-- somebody runs code against, and when, is theirs.
drop policy if exists container_workspaces_select_self on public.container_workspaces;
create policy container_workspaces_select_self on public.container_workspaces
  for select to authenticated using (user_id = auth.uid());

-- SELECT and nothing else. A policy filters rows a role already has the
-- privilege to touch, so the privilege is where "cannot write" is decided; the
-- grant is also required because the table is new and `authenticated` starts
-- with nothing on it.
grant select on public.container_workspaces to authenticated;
revoke insert, update, delete on public.container_workspaces from authenticated;
revoke all on public.container_workspaces from anon;
