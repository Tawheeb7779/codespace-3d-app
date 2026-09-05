-- ---------------------------------------------------------------------------
-- Project invitations
--
-- Replaces a placeholder that inserted an email address into
-- `project_members.user_id`, a uuid column — an insert that could only ever
-- fail against a real database. Inviting somebody who does not yet have an
-- account cannot be a membership row, because there is no account to reference
-- yet. It has to be a pending record the invitee redeems after signing in.
--
-- Three properties do the security work here:
--
--   * Only a *hash* of the token is stored. A leaked database backup, a log
--     line, or an admin browsing the table sees nothing usable — the raw token
--     exists only in the link, shown once to whoever created it.
--   * Redemption goes through a SECURITY DEFINER function. The invitee is by
--     definition not yet a member, so no policy could let them read the
--     invitation and create their own membership; the function is the single,
--     audited path that can.
--   * The function is the only thing that may write `project_members` for the
--     caller, and it re-checks expiry and prior use inside one statement, so
--     two simultaneous redemptions cannot both succeed.
-- ---------------------------------------------------------------------------

create table if not exists public.project_invitations (
  id           uuid        primary key default gen_random_uuid(),
  project_id   text        not null references public.projects (id) on delete cascade,
  -- sha-256 of the raw token, hex encoded. The raw token is never stored.
  token_hash   text        not null unique,
  -- Who it was addressed to, for display and to stop it being redeemed by
  -- somebody who merely got hold of the link.
  email        text        not null,
  role         member_role not null default 'editor',
  invited_by   uuid        not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  -- Set once, when redeemed. A second redemption finds this non-null.
  accepted_at  timestamptz,
  accepted_by  uuid        references public.profiles (id) on delete set null,
  revoked_at   timestamptz,

  constraint project_invitations_email_format check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint project_invitations_email_length check (char_length(email) between 3 and 320),
  -- 32 random bytes, hex encoded, hashed to sha-256 hex: always 64 characters.
  constraint project_invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  -- An owner cannot be created by invitation; ownership transfer is separate.
  constraint project_invitations_role_not_owner check (role <> 'owner')
);

create index if not exists project_invitations_project_idx
  on public.project_invitations (project_id, created_at desc);
create index if not exists project_invitations_email_idx
  on public.project_invitations (lower(email));

alter table public.project_invitations enable row level security;

-- Only someone who can administer the project may see or manage its
-- invitations. Note there is deliberately no policy letting an *invitee* read
-- their own invitation: they have no membership yet, and matching on email
-- would let anyone enumerate invitations by guessing addresses. Redemption
-- goes through the function below instead.

drop policy if exists project_invitations_select on public.project_invitations;
create policy project_invitations_select on public.project_invitations
  for select to authenticated using (public.can_administer_project(project_id));

drop policy if exists project_invitations_insert on public.project_invitations;
create policy project_invitations_insert on public.project_invitations
  for insert to authenticated
  with check (public.can_administer_project(project_id) and invited_by = auth.uid());

-- Update exists only to revoke. The columns that matter — token, project, role
-- — are pinned by the trigger below, so an admin cannot repoint an outstanding
-- invitation at another project or escalate its role after the fact.
drop policy if exists project_invitations_update on public.project_invitations;
create policy project_invitations_update on public.project_invitations
  for update to authenticated
  using (public.can_administer_project(project_id))
  with check (public.can_administer_project(project_id));

drop policy if exists project_invitations_delete on public.project_invitations;
create policy project_invitations_delete on public.project_invitations
  for delete to authenticated using (public.can_administer_project(project_id));

/**
 * Keep what an invitation *grants* immutable.
 *
 * Without this, the update policy above would let an admin of project A edit
 * an invitation to point at project B, or raise its role to admin after the
 * invitee had already been told what they were accepting.
 *
 * Marking one used or revoked stays allowed — that is how redemption and
 * revocation work, and neither grants anything on its own. Clearing those
 * marks does not: re-arming a spent invitation would turn a one-time token
 * into a reusable one.
 */
create or replace function public.guard_invitation_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.project_id  is distinct from old.project_id
     or new.token_hash is distinct from old.token_hash
     or new.email      is distinct from old.email
     or new.role       is distinct from old.role
     or new.invited_by is distinct from old.invited_by
  then
    raise exception 'An invitation can only be revoked, not edited';
  end if;

  if old.accepted_at is not null and new.accepted_at is null then
    raise exception 'A redeemed invitation cannot be re-armed';
  end if;
  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'A revoked invitation cannot be re-armed';
  end if;

  return new;
end;
$$;

drop trigger if exists project_invitations_guard on public.project_invitations;
create trigger project_invitations_guard
  before update on public.project_invitations
  for each row execute function public.guard_invitation_update();

/**
 * Redeem an invitation.
 *
 * SECURITY DEFINER because the caller is not a member yet and therefore cannot
 * read the invitation or write `project_members` under any policy. Everything
 * the function trusts is re-derived here rather than passed in: the project and
 * role come from the stored row, and the identity from `auth.uid()`.
 *
 * The single UPDATE ... WHERE accepted_at is null is what makes redemption
 * one-time: two concurrent calls contend for the same row, and only the one
 * that wins the update proceeds to create membership.
 *
 * Returns the project id on success. Every failure raises, with a message that
 * says what is wrong without revealing anything about a project the caller has
 * no relationship to.
 */
create or replace function public.accept_project_invitation(raw_token text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hashed     text;
  claimed    public.project_invitations%rowtype;
  caller     uuid := auth.uid();
  caller_email text;
begin
  if caller is null then
    raise exception 'You must be signed in to accept an invitation';
  end if;
  if raw_token is null or raw_token !~ '^[0-9a-f]{64}$' then
    raise exception 'That invitation link is not valid';
  end if;

  hashed := encode(digest(raw_token, 'sha256'), 'hex');

  select email into caller_email from public.profiles where id = caller;

  -- One statement claims the row: expiry, revocation and prior use are all
  -- checked in the WHERE clause, so a concurrent second call matches nothing.
  update public.project_invitations
     set accepted_at = now(),
         accepted_by = caller
   where token_hash = hashed
     and accepted_at is null
     and revoked_at is null
     and expires_at > now()
     -- Addressed to this account. A leaked link is useless to anyone else.
     and lower(email) = lower(coalesce(caller_email, ''))
  returning * into claimed;

  if claimed.id is null then
    -- Deliberately one message for every failure mode. Distinguishing
    -- "expired" from "already used" from "not yours" would let someone probe
    -- which tokens exist.
    raise exception 'That invitation is not valid, has expired, or has already been used';
  end if;

  insert into public.project_members (project_id, user_id, role)
  values (claimed.project_id, caller, claimed.role)
  on conflict (project_id, user_id) do update set role = excluded.role;

  insert into public.project_activity (project_id, actor_id, action, detail)
  values (claimed.project_id, caller, 'member.added',
          jsonb_build_object('subject', 'accepted an invitation'));

  return claimed.project_id;
end;
$$;

-- The function is the redemption path, so it must be callable by any signed-in
-- account. Its own checks are what constrain it.
revoke all on function public.accept_project_invitation(text) from public;
grant execute on function public.accept_project_invitation(text) to authenticated;

grant select, insert, update, delete on public.project_invitations to authenticated;
revoke all on public.project_invitations from anon;
