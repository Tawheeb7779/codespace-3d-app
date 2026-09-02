-- Authorization boundary tests for the Forge IDE schema.
--
-- Run against a database that already has 0001_init.sql applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
--
-- The script creates its own fixtures, asserts, and rolls everything back, so
-- it is safe to run repeatedly against a development database. Every assertion
-- runs as `authenticated` with a specific `auth.uid()`, which is how Supabase
-- evaluates a real request.

begin;

-- --------------------------------------------------------------------------
-- Test harness
-- --------------------------------------------------------------------------

create or replace function pg_temp.assert(condition boolean, description text)
returns void language plpgsql as $$
begin
  if condition then
    raise notice 'ok    %', description;
  else
    raise exception 'FAIL  %', description;
  end if;
end;
$$;

create or replace function pg_temp.act_as(target uuid)
returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', target, 'role', 'authenticated')::text, true);
end;
$$;

create or replace function pg_temp.act_as_admin()
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- --------------------------------------------------------------------------
-- Fixtures — owner, editor, viewer and an unrelated outsider
-- --------------------------------------------------------------------------

select pg_temp.act_as_admin();

insert into auth.users (id, email, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', 'owner@test.dev',    '{"full_name":"Owner"}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'editor@test.dev',   '{"full_name":"Editor"}'::jsonb),
  ('33333333-3333-3333-3333-333333333333', 'viewer@test.dev',   '{"full_name":"Viewer"}'::jsonb),
  ('44444444-4444-4444-4444-444444444444', 'outsider@test.dev', '{"full_name":"Outsider"}'::jsonb)
on conflict (id) do nothing;

-- The auth trigger mirrors these into profiles; insert directly in case the
-- trigger is not installed on this database.
insert into public.profiles (id, email, display_name)
values
  ('11111111-1111-1111-1111-111111111111', 'owner@test.dev', 'Owner'),
  ('22222222-2222-2222-2222-222222222222', 'editor@test.dev', 'Editor'),
  ('33333333-3333-3333-3333-333333333333', 'viewer@test.dev', 'Viewer'),
  ('44444444-4444-4444-4444-444444444444', 'outsider@test.dev', 'Outsider')
on conflict (id) do nothing;

insert into public.projects (id, owner_id, name, description)
values ('prj_test_alpha', '11111111-1111-1111-1111-111111111111', 'Alpha', 'fixture');

insert into public.project_members (project_id, user_id, role)
values
  ('prj_test_alpha', '22222222-2222-2222-2222-222222222222', 'editor'),
  ('prj_test_alpha', '33333333-3333-3333-3333-333333333333', 'viewer');

insert into public.project_files (project_id, path, content)
values ('prj_test_alpha', 'src/main.ts', 'export const a = 1;');

-- --------------------------------------------------------------------------
-- Reads
-- --------------------------------------------------------------------------

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_alpha') = 1,
  'owner reads their project');

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_alpha') = 1,
  'viewer reads a project they are a member of');
select pg_temp.assert(
  (select count(*) from public.project_files where project_id = 'prj_test_alpha') = 1,
  'viewer reads project files');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_alpha') = 0,
  'outsider cannot see the project (IDOR by id is blocked)');
select pg_temp.assert(
  (select count(*) from public.project_files where project_id = 'prj_test_alpha') = 0,
  'outsider cannot read project files');
select pg_temp.assert(
  (select count(*) from public.project_members where project_id = 'prj_test_alpha') = 0,
  'outsider cannot enumerate members');

-- --------------------------------------------------------------------------
-- Writes
-- --------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
insert into public.project_files (project_id, path, content)
values ('prj_test_alpha', 'src/added-by-editor.ts', 'ok');
select pg_temp.assert(
  (select count(*) from public.project_files where path = 'src/added-by-editor.ts') = 1,
  'editor writes files');

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
do $$
begin
  begin
    insert into public.project_files (project_id, path, content)
    values ('prj_test_alpha', 'src/sneaky.ts', 'nope');
    raise exception 'FAIL  viewer was able to insert a file';
  exception
    when insufficient_privilege then raise notice 'ok    viewer cannot insert files';
  end;
end $$;

select pg_temp.assert(
  (select count(*) from public.project_files
    where project_id = 'prj_test_alpha' and path = 'src/main.ts' and content <> 'export const a = 1;') = 0,
  'viewer update of a file changes nothing');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
do $$
begin
  begin
    insert into public.project_files (project_id, path, content)
    values ('prj_test_alpha', 'src/outsider.ts', 'nope');
    raise exception 'FAIL  outsider was able to insert a file';
  exception
    when insufficient_privilege then raise notice 'ok    outsider cannot insert files';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Privilege escalation
-- --------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
update public.project_members set role = 'owner'
 where project_id = 'prj_test_alpha' and user_id = '22222222-2222-2222-2222-222222222222';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select role from public.project_members
    where project_id = 'prj_test_alpha' and user_id = '22222222-2222-2222-2222-222222222222') = 'editor',
  'editor cannot promote themselves');

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
delete from public.projects where id = 'prj_test_alpha';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_alpha') = 1,
  'viewer cannot delete the project');

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
delete from public.projects where id = 'prj_test_alpha';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_alpha') = 1,
  'editor cannot delete the project');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
insert into public.projects (id, owner_id, name)
values ('prj_test_stolen', '11111111-1111-1111-1111-111111111111', 'Not mine')
on conflict do nothing;
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_stolen') = 0,
  'a user cannot create a project owned by someone else');

-- --------------------------------------------------------------------------
-- Public visibility grants read, never write
-- --------------------------------------------------------------------------

select pg_temp.act_as_admin();
update public.projects set visibility = 'public' where id = 'prj_test_alpha';

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_alpha') = 1,
  'a public project is readable by any signed-in user');
do $$
begin
  begin
    insert into public.project_files (project_id, path, content)
    values ('prj_test_alpha', 'src/public-write.ts', 'nope');
    raise exception 'FAIL  public visibility allowed a write';
  exception
    when insufficient_privilege then raise notice 'ok    public visibility does not grant write access';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Path constraints are enforced by the database, not only the client
-- --------------------------------------------------------------------------

select pg_temp.act_as_admin();
do $$
begin
  begin
    insert into public.project_files (project_id, path, content)
    values ('prj_test_alpha', '../escape.ts', 'nope');
    raise exception 'FAIL  a traversing path was accepted';
  exception
    when check_violation then raise notice 'ok    traversing paths are rejected by a check constraint';
  end;
  begin
    insert into public.project_files (project_id, path, content)
    values ('prj_test_alpha', '/absolute.ts', 'nope');
    raise exception 'FAIL  an absolute path was accepted';
  exception
    when check_violation then raise notice 'ok    absolute paths are rejected by a check constraint';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Activity is append-only and cannot be forged
-- --------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
insert into public.project_activity (project_id, actor_id, action)
values ('prj_test_alpha', '22222222-2222-2222-2222-222222222222', 'commit');
do $$
begin
  begin
    insert into public.project_activity (project_id, actor_id, action)
    values ('prj_test_alpha', '11111111-1111-1111-1111-111111111111', 'impersonation');
    raise exception 'FAIL  activity could be filed under another user';
  exception
    when insufficient_privilege then raise notice 'ok    activity cannot be attributed to another user';
  end;
end $$;

select pg_temp.act_as_admin();
select pg_temp.assert(true, 'all authorization assertions passed');

rollback;
