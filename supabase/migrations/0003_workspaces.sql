-- ---------------------------------------------------------------------------
-- Workspaces
--
-- A workspace is one account's named grouping of projects, plus the ordering
-- and pinning that go with it. It is deliberately *not* a sharing boundary:
-- sharing stays per project, decided by `project_members`, so adding a project
-- to a workspace can never widen who can read it.
--
-- That is why `project_ids` is a plain text array rather than a join table.
-- A join table would invite a policy that reads "you can see this project
-- because it is in a workspace you own", which is exactly the rule we do not
-- want. Here the array is only an ordering hint owned by one account; every
-- read of the projects themselves still goes through the project policies.
-- A stale id in the array is harmless — it resolves to nothing.
-- ---------------------------------------------------------------------------

create table if not exists public.workspaces (
  id          text        primary key,
  owner_id    uuid        not null references public.profiles (id) on delete cascade,
  name        text        not null,
  description text        not null default '',
  project_ids text[]      not null default '{}',
  pinned      boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  opened_at   timestamptz not null default now(),
  constraint workspaces_name_length check (char_length(name) between 1 and 60),
  constraint workspaces_description_length check (char_length(description) <= 280),
  -- Bounded so one row cannot become an unbounded document.
  constraint workspaces_project_count check (array_length(project_ids, 1) is null
                                             or array_length(project_ids, 1) <= 200)
);

create index if not exists workspaces_owner_idx
  on public.workspaces (owner_id, opened_at desc);

drop trigger if exists workspaces_touch on public.workspaces;
create trigger workspaces_touch
  before update on public.workspaces
  for each row execute function public.touch_updated_at();

alter table public.workspaces enable row level security;

-- A workspace is private to its owner. There is no member policy, because a
-- workspace grants no access to anything: it is a view over projects the
-- caller can already read.

drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces
  for insert to authenticated with check (owner_id = auth.uid());

-- `using` keeps someone from editing a row they do not own; `with check`
-- keeps an owner from reassigning a row to somebody else.
drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists workspaces_delete on public.workspaces;
create policy workspaces_delete on public.workspaces
  for delete to authenticated using (owner_id = auth.uid());

grant select, insert, update, delete on public.workspaces to authenticated;
revoke all on public.workspaces from anon;
