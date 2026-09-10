-- ---------------------------------------------------------------------------
-- Comments on a project's code
--
-- Additive only: one new table, its indexes and its policies. Nothing existing
-- is altered or dropped, so this migration cannot lose anybody's work and can
-- be applied to a live database without a window.
--
-- A comment is anchored to a path and, optionally, a line. It deliberately does
-- **not** reference `project_files`: a comment outlives the line it was written
-- about, and a foreign key to a file row would delete the conversation the
-- moment somebody renamed the file. The anchor is therefore a plain path, and a
-- comment whose file is gone is shown as orphaned rather than destroyed.
--
-- Threads are one level deep, by `parent_id`. Deeper nesting is a feature
-- nobody asks for in a code review and a rendering problem in a 264px panel.
--
-- Authorisation reuses the existing helpers — `can_read_project`,
-- `can_write_project`, `can_administer_project` — rather than restating the
-- membership rules. Restating them is how two places drift and one of them
-- becomes wrong.
-- ---------------------------------------------------------------------------

create table if not exists public.project_comments (
  id          uuid        primary key default gen_random_uuid(),
  project_id  text        not null references public.projects (id) on delete cascade,
  -- The thread this reply belongs to. Null for a thread's first comment.
  parent_id   uuid        references public.project_comments (id) on delete cascade,
  author_id   uuid        not null references public.profiles (id) on delete cascade,
  -- Where in the project. A path, not a file id: see the note above.
  path        text        not null default '',
  -- 1-based, or null for a comment about the file as a whole.
  line        integer,
  body        text        not null,
  -- Who was named, so a mention can be found without parsing every body.
  mentions    uuid[]      not null default '{}',
  resolved_at timestamptz,
  resolved_by uuid        references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint project_comments_body_length check (char_length(body) between 1 and 4000),
  constraint project_comments_path_length check (char_length(path) <= 1024),
  constraint project_comments_line_positive check (line is null or line > 0),
  -- Bounded so one comment cannot notify an unbounded list.
  constraint project_comments_mention_count check (array_length(mentions, 1) is null
                                                   or array_length(mentions, 1) <= 50),
  -- A reply is part of its parent's thread and has no anchor of its own; a
  -- reply that could sit on a different line would make "thread" meaningless.
  constraint project_comments_reply_has_no_anchor check (parent_id is null or line is null),
  -- Only a thread's first comment can be resolved: resolving a single reply
  -- would leave a thread half-closed with no way to read which half.
  constraint project_comments_reply_unresolved check (parent_id is null or resolved_at is null),
  constraint project_comments_resolved_pair check (
    (resolved_at is null and resolved_by is null)
    or (resolved_at is not null and resolved_by is not null)
  )
);

-- The panel's main read: a project's threads, newest first.
create index if not exists project_comments_project_idx
  on public.project_comments (project_id, created_at desc);

-- The editor's read: what is on this file.
create index if not exists project_comments_path_idx
  on public.project_comments (project_id, path, line);

create index if not exists project_comments_thread_idx
  on public.project_comments (parent_id);

-- "What was I named in?", without scanning every body in the project.
create index if not exists project_comments_mentions_idx
  on public.project_comments using gin (mentions);

drop trigger if exists project_comments_touch on public.project_comments;
create trigger project_comments_touch
  before update on public.project_comments
  for each row execute function public.touch_updated_at();

alter table public.project_comments enable row level security;

-- Reading follows the project. A public project's comments are public, exactly
-- as its code is: a conversation about code somebody can already read is not a
-- separate secret, and pretending otherwise would be a false assurance.
drop policy if exists project_comments_select on public.project_comments;
create policy project_comments_select on public.project_comments
  for select to authenticated
  using (public.can_read_project(project_id));

-- Writing needs a role. A viewer on a public project may read the code and the
-- discussion and add neither.
--
-- `author_id = auth.uid()` is the part that matters most here: without it a
-- member could file a comment under a colleague's name, which is a forged
-- record in a conversation people make decisions from.
drop policy if exists project_comments_insert on public.project_comments;
create policy project_comments_insert on public.project_comments
  for insert to authenticated
  with check (
    public.can_write_project(project_id)
    and author_id = auth.uid()
  );

-- An author edits their own comment; an administrator may resolve a thread they
-- did not write, which is the whole point of resolving. Neither may change who
-- wrote it or move it to another project.
drop policy if exists project_comments_update on public.project_comments;
create policy project_comments_update on public.project_comments
  for update to authenticated
  using (
    public.can_write_project(project_id)
    and (author_id = auth.uid() or public.can_administer_project(project_id))
  )
  -- Parenthesised deliberately: `and` binds tighter than `or`, so without
  -- these brackets the clause reads "(may write and is the author) or is an
  -- administrator", which is a different and weaker rule than the `using`
  -- above.
  with check (
    public.can_write_project(project_id)
    and (author_id = auth.uid() or public.can_administer_project(project_id))
  );

drop policy if exists project_comments_delete on public.project_comments;
create policy project_comments_delete on public.project_comments
  for delete to authenticated
  using (
    author_id = auth.uid()
    or public.can_administer_project(project_id)
  );

-- ---------------------------------------------------------------------------
-- Authorship and project cannot be rewritten
--
-- The `with check` above constrains a row as it lands, but an update that keeps
-- `author_id = auth.uid()` false-to-true is not the only way to forge one: an
-- administrator passes `can_administer_project` and could otherwise reassign a
-- comment to somebody else, or move a thread into a project where different
-- people can read it. Neither is an edit; both are fabrication.
-- ---------------------------------------------------------------------------
create or replace function public.guard_comment_identity()
returns trigger
language plpgsql
as $$
begin
  if new.author_id is distinct from old.author_id then
    raise exception 'a comment cannot change author';
  end if;
  if new.project_id is distinct from old.project_id then
    raise exception 'a comment cannot move between projects';
  end if;
  if new.parent_id is distinct from old.parent_id then
    raise exception 'a comment cannot move between threads';
  end if;
  return new;
end;
$$;

drop trigger if exists project_comments_guard_identity on public.project_comments;
create trigger project_comments_guard_identity
  before update on public.project_comments
  for each row execute function public.guard_comment_identity();

-- ---------------------------------------------------------------------------
-- The grant the policies rest on
--
-- RLS is the authorization boundary; this only makes the table reachable at
-- all. A policy admits a statement, and a grant is what lets the statement be
-- attempted — without this every request fails with "permission denied" no
-- matter what the policies say.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.project_comments to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
--
-- The panel listens for inserts and updates rather than polling. Adding the
-- table to the publication is what makes that possible; RLS still decides what
-- each subscriber is allowed to receive, so this widens nothing.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'project_comments'
    ) then
      alter publication supabase_realtime add table public.project_comments;
    end if;
  end if;
end
$$;
