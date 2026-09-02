-- Minimal Supabase-compatible shim, so the authorization tests can run against
-- a plain PostgreSQL instance instead of requiring a hosted Supabase project.
--
-- It creates only what the schema and its policies actually depend on:
--   * the `anon`, `authenticated` and `service_role` roles
--   * an `auth` schema with a `users` table
--   * `auth.uid()`, reading the same `request.jwt.claims` GUC Supabase sets
--
-- Against a real Supabase database this file is unnecessary — and running it
-- there is a no-op, because every object is created only if missing.
--
--   createdb forge_rls_test
--   psql forge_rls_test -v ON_ERROR_STOP=1 -f supabase/tests/00-bootstrap.sql
--   psql forge_rls_test -v ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql
--   psql forge_rls_test -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql

create extension if not exists "pgcrypto";

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id                   uuid primary key default gen_random_uuid(),
  email                text,
  raw_user_meta_data   jsonb not null default '{}'::jsonb,
  raw_app_meta_data    jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

-- Supabase exposes the JWT payload through the `request.jwt.claims` setting.
-- Reading it the same way keeps the policies identical in both environments.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  );
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
