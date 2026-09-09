-- TA CODE — make account creation survive its own profile mirror.
--
-- The symptom this fixes is "the owner can sign in and nobody else can", which
-- is not a sign-in fault at all. `on_auth_user_created` is an AFTER INSERT
-- trigger on `auth.users`, so it runs inside the transaction that creates the
-- account: if it raises, the INSERT is rolled back and the account is never
-- created. Supabase reports that to the browser as "Database error saving new
-- user". Anyone who already has a row — the person who set the project up —
-- signs in normally forever after, because their account is not being created
-- again. Every new person is refused.
--
-- Two inputs made the previous trigger raise, both confirmed by executing them
-- against this schema on a real PostgreSQL:
--
--   full_name = ""      `coalesce` skips NULL, not the empty string, so an
--                       OAuth provider that returns an empty display name
--                       reached `profiles_display_name_length` with zero
--                       characters and violated it.
--   full_name > 80      Nothing clamped the length, so a real Google display
--                       name longer than eighty characters violated the same
--                       constraint.
--
-- The fix is in two independent layers, because this is a place where being
-- wrong costs every new user the product.
--
--   1. The derivation is made total: it cannot produce a value the constraint
--      rejects, for any input, including an absent email.
--   2. The whole thing is wrapped so that even a future constraint nobody
--      thought about cannot block account creation. A person who can sign in
--      without a profile row is recoverable; a person who cannot create an
--      account is simply gone.
--
-- Idempotent, like every migration here: it replaces a function, re-creates one
-- trigger, and backfills rows that are missing.

-- ---------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- The display name, narrowed step by step until something usable remains.
  candidate text;
begin
  -- `nullif(btrim(...), '')` is the whole difference from the previous version:
  -- an empty or whitespace-only name from a provider becomes NULL and falls
  -- through to the next source, instead of being written and rejected.
  candidate := nullif(
    btrim(
      coalesce(
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'name',
        -- GitHub sends the login here when the account has no display name set.
        new.raw_user_meta_data ->> 'user_name',
        new.raw_user_meta_data ->> 'preferred_username',
        ''
      )
    ),
    ''
  );

  -- The local part of the email, for a provider that sends no name at all.
  if candidate is null then
    candidate := nullif(btrim(split_part(coalesce(new.email, ''), '@', 1)), '');
  end if;

  -- A last resort that is always valid. An account with neither a name nor an
  -- email is unusual, not impossible, and must still be creatable.
  if candidate is null then
    candidate := 'Developer';
  end if;

  -- The constraint allows eighty characters. `left` is a clamp rather than a
  -- rejection: a person with a long name gets a truncated one, not a failed
  -- signup.
  candidate := left(candidate, 80);

  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    candidate,
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  return new;

exception
  when others then
    -- Defence in depth, and deliberately silent about the cause: this runs
    -- inside account creation, and re-raising is exactly the failure being
    -- fixed. One more attempt with values that cannot violate anything, and if
    -- even that fails the account is still created.
    begin
      insert into public.profiles (id, email, display_name)
      values (new.id, coalesce(new.email, ''), 'Developer')
      on conflict (id) do nothing;
    exception
      when others then
        null;
    end;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Repair
-- ---------------------------------------------------------------------------

-- Any account that was created while the trigger was failing has no profile
-- row, and every table in this schema has a foreign key to `profiles` — so
-- those accounts can authenticate and can do nothing at all. Backfilling is
-- safe and idempotent: `on conflict do nothing` leaves existing rows alone, and
-- the derivation is the same total one the trigger now uses.
--
-- Rows are only ever created for accounts that already exist in `auth.users`,
-- so this cannot invent a profile for anybody.
insert into public.profiles (id, email, display_name, avatar_url)
select
  u.id,
  coalesce(u.email, ''),
  left(
    coalesce(
      nullif(
        btrim(
          coalesce(
            u.raw_user_meta_data ->> 'full_name',
            u.raw_user_meta_data ->> 'name',
            u.raw_user_meta_data ->> 'user_name',
            u.raw_user_meta_data ->> 'preferred_username',
            ''
          )
        ),
        ''
      ),
      nullif(btrim(split_part(coalesce(u.email, ''), '@', 1)), ''),
      'Developer'
    ),
    80
  ),
  u.raw_user_meta_data ->> 'avatar_url'
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;
