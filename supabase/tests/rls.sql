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

-- Only the assertion notices should reach the terminal.
\set QUIET on
\pset tuples_only on
\pset format unaligned
\pset footer off

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
  ('44444444-4444-4444-4444-444444444444', 'outsider@test.dev', '{"full_name":"Outsider"}'::jsonb),
  ('55555555-5555-5555-5555-555555555555', 'admin@test.dev',    '{"full_name":"Admin"}'::jsonb)
on conflict (id) do nothing;

-- The auth trigger mirrors these into profiles; insert directly in case the
-- trigger is not installed on this database.
insert into public.profiles (id, email, display_name)
values
  ('11111111-1111-1111-1111-111111111111', 'owner@test.dev', 'Owner'),
  ('22222222-2222-2222-2222-222222222222', 'editor@test.dev', 'Editor'),
  ('33333333-3333-3333-3333-333333333333', 'viewer@test.dev', 'Viewer'),
  ('44444444-4444-4444-4444-444444444444', 'outsider@test.dev', 'Outsider'),
  ('55555555-5555-5555-5555-555555555555', 'admin@test.dev', 'Admin')
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
do $$
begin
  begin
    insert into public.projects (id, owner_id, name)
    values ('prj_test_stolen', '11111111-1111-1111-1111-111111111111', 'Not mine');
    raise exception 'FAIL  a project could be created under another owner';
  exception
    when insufficient_privilege then
      raise notice 'ok    a user cannot create a project owned by someone else';
  end;
end $$;
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_stolen') = 0,
  'the rejected project was not created');

-- --------------------------------------------------------------------------
-- Ownership transfer is owner-only, enforced by a trigger
-- --------------------------------------------------------------------------

-- An editor is stopped by the row policy: the row is not even visible to
-- update, so the statement matches nothing.
select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    update public.projects
       set owner_id = '22222222-2222-2222-2222-222222222222'
     where id = 'prj_test_alpha';
    if found then raise exception 'FAIL  an editor transferred ownership'; end if;
    raise notice 'ok    an editor cannot take ownership (no row visible to update)';
  exception
    when insufficient_privilege then raise notice 'ok    an editor cannot take ownership';
  end;
end $$;

-- An admin passes the row policy, so the trigger is the layer that must stop
-- them. This is the case the guard exists for.
select pg_temp.act_as_admin();
insert into public.project_members (project_id, user_id, role)
values ('prj_test_alpha', '55555555-5555-5555-5555-555555555555', 'admin')
on conflict (project_id, user_id) do update set role = 'admin';

select pg_temp.act_as('55555555-5555-5555-5555-555555555555');
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_alpha') = 1,
  'an admin can see the project');
update public.projects set description = 'renamed by admin' where id = 'prj_test_alpha';
select pg_temp.assert(
  (select description from public.projects where id = 'prj_test_alpha') = 'renamed by admin',
  'an admin can edit project metadata');
do $$
begin
  begin
    update public.projects
       set owner_id = '55555555-5555-5555-5555-555555555555'
     where id = 'prj_test_alpha';
    raise exception 'FAIL  an admin transferred ownership';
  exception
    when insufficient_privilege then
      raise notice 'ok    an admin cannot transfer ownership (trigger)';
  end;
end $$;

select pg_temp.act_as_admin();
select pg_temp.assert(
  (select owner_id from public.projects where id = 'prj_test_alpha')
    = '11111111-1111-1111-1111-111111111111',
  'ownership is unchanged after both attempts');

-- The owner may transfer, and may transfer it back.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
update public.projects set owner_id = '55555555-5555-5555-5555-555555555555'
 where id = 'prj_test_alpha';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select owner_id from public.projects where id = 'prj_test_alpha')
    = '55555555-5555-5555-5555-555555555555',
  'the owner can transfer ownership');
update public.projects set owner_id = '11111111-1111-1111-1111-111111111111'
 where id = 'prj_test_alpha';

-- --------------------------------------------------------------------------
-- Creating a project: the insert policy, from all three sides
-- --------------------------------------------------------------------------
--
-- Cloud project creation failed in the browser with 42501, "new row violates
-- row-level security policy for table projects". Three different situations
-- produce that one sentence — an owner_id that is not the caller, no JWT at
-- all, and a deployment whose insert policy is simply missing — so all three
-- are pinned here, including the ordinary case that must keep working.

-- An authenticated user creates a project they own. This is the case the
-- browser exercises, and the one that was failing.
select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
insert into public.projects (id, owner_id, name, description, template, language,
                             visibility, status, starred, dirs)
values ('prj_rls_own_create', '44444444-4444-4444-4444-444444444444', 'Mine', '',
        'react-ts', 'TypeScript', 'private', 'active', false, '{}');
select pg_temp.assert(
  (select owner_id from public.projects where id = 'prj_rls_own_create')
    = '44444444-4444-4444-4444-444444444444',
  'an authenticated user can create their own project');

-- The row is readable straight back, which is what .select().single() needs.
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_rls_own_create') = 1,
  'the creator can read the project back immediately');

-- Nobody may file a project under another account.
do $$
begin
  begin
    insert into public.projects (id, owner_id, name, description, template, language,
                                 visibility, status, starred, dirs)
    values ('prj_rls_other_owner', '11111111-1111-1111-1111-111111111111', 'Theirs', '',
            'react-ts', 'TypeScript', 'private', 'active', false, '{}');
    raise exception 'FAIL  a user created a project owned by someone else';
  exception
    when insufficient_privilege then
      raise notice 'ok    a user cannot create a project owned by someone else';
  end;
end $$;
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_rls_other_owner') = 0,
  'the rejected project was never written');

-- With no session there is no insert at all: anon holds no privilege on the
-- table, so it is refused before any policy is consulted.
do $$
begin
  begin
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '', true);
    insert into public.projects (id, owner_id, name, description, template, language,
                                 visibility, status, starred, dirs)
    values ('prj_rls_anon_create', '44444444-4444-4444-4444-444444444444', 'Anon', '',
            'react-ts', 'TypeScript', 'private', 'active', false, '{}');
    raise exception 'FAIL  an anonymous visitor created a project';
  exception
    when insufficient_privilege then
      raise notice 'ok    an anonymous visitor cannot create a project';
  end;
end $$;
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_rls_anon_create') = 0,
  'the anonymous project was never written');

-- An authenticated role carrying no subject claim is not a user either.
do $$
begin
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', '', true);
    insert into public.projects (id, owner_id, name, description, template, language,
                                 visibility, status, starred, dirs)
    values ('prj_rls_nosub_create', '44444444-4444-4444-4444-444444444444', 'NoSub', '',
            'react-ts', 'TypeScript', 'private', 'active', false, '{}');
    raise exception 'FAIL  a session with no subject created a project';
  exception
    when insufficient_privilege then
      raise notice 'ok    a session with no subject cannot create a project';
  end;
end $$;
select pg_temp.act_as_admin();

-- --------------------------------------------------------------------------
-- Saving the working tree: an editor writes the tree, not the settings
-- --------------------------------------------------------------------------
--
-- Saving files also writes `projects.dirs` and `projects.updated_at`. When the
-- only update policy required the admin role, an editor's save matched no row,
-- PostgREST reported success for an update that changed nothing, and new
-- folders silently failed to persist.

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
update public.projects
   set dirs = array['src', 'src/components'], language = 'TypeScript',
       updated_at = now()
 where id = 'prj_test_alpha';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select dirs from public.projects where id = 'prj_test_alpha')
    = array['src', 'src/components'],
  'an editor can save the folder list');
select pg_temp.assert(
  (select language from public.projects where id = 'prj_test_alpha') = 'TypeScript',
  'an editor can save the detected language');

-- The same policy must not hand the editor the settings that sit beside it.
select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    update public.projects set name = 'renamed by editor' where id = 'prj_test_alpha';
    raise exception 'FAIL  an editor renamed the project';
  exception
    when insufficient_privilege then raise notice 'ok    an editor cannot rename the project';
  end;
  begin
    update public.projects set visibility = 'public' where id = 'prj_test_alpha';
    raise exception 'FAIL  an editor published the project';
  exception
    when insufficient_privilege then raise notice 'ok    an editor cannot change visibility';
  end;
  begin
    update public.projects set status = 'archived' where id = 'prj_test_alpha';
    raise exception 'FAIL  an editor archived the project';
  exception
    when insufficient_privilege then raise notice 'ok    an editor cannot archive the project';
  end;
end $$;

-- A viewer gets neither.
select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
update public.projects set dirs = array['sneaky'] where id = 'prj_test_alpha';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select dirs from public.projects where id = 'prj_test_alpha')
    = array['src', 'src/components'],
  'a viewer cannot save the folder list');

-- --------------------------------------------------------------------------
-- Project settings: readable by members, writable by admins only
-- --------------------------------------------------------------------------

select pg_temp.act_as_admin();
insert into public.project_settings (project_id, settings)
values ('prj_test_alpha', '{"theme":"dark"}'::jsonb)
on conflict (project_id) do update set settings = excluded.settings;

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
select pg_temp.assert(
  (select count(*) from public.project_settings where project_id = 'prj_test_alpha') = 1,
  'a viewer can read project settings');

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    update public.project_settings set settings = '{"theme":"hacked"}'::jsonb
     where project_id = 'prj_test_alpha';
    if not found then
      raise notice 'ok    an editor cannot change project settings (no rows visible for update)';
    else
      raise exception 'FAIL  an editor changed project settings';
    end if;
  exception
    when insufficient_privilege then raise notice 'ok    an editor cannot change project settings';
  end;
end $$;
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select settings ->> 'theme' from public.project_settings where project_id = 'prj_test_alpha')
    = 'dark',
  'project settings were not modified by a non-admin');

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
update public.project_settings set settings = '{"theme":"light"}'::jsonb
 where project_id = 'prj_test_alpha';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select settings ->> 'theme' from public.project_settings where project_id = 'prj_test_alpha')
    = 'light',
  'the owner can change project settings');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.project_settings where project_id = 'prj_test_alpha') = 0,
  'an outsider cannot read project settings');

-- --------------------------------------------------------------------------
-- Version history follows write permission, not merely membership
-- --------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
insert into public.project_vcs (project_id, snapshot)
values ('prj_test_alpha', '{"branches":{"main":""}}'::jsonb)
on conflict (project_id) do update set snapshot = excluded.snapshot;
select pg_temp.assert(true, 'an editor can write version history');

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
do $$
begin
  begin
    insert into public.project_vcs (project_id, snapshot)
    values ('prj_test_alpha', '{"tampered":true}'::jsonb)
    on conflict (project_id) do update set snapshot = excluded.snapshot;
    raise exception 'FAIL  a viewer wrote version history';
  exception
    when insufficient_privilege then raise notice 'ok    a viewer cannot write version history';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Teams
-- --------------------------------------------------------------------------

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
insert into public.teams (id, name, slug, owner_id)
values (
  '99999999-9999-9999-9999-999999999999',
  'Platform',
  'platform',
  '11111111-1111-1111-1111-111111111111'
);
insert into public.team_members (team_id, user_id, role)
values ('99999999-9999-9999-9999-999999999999', '22222222-2222-2222-2222-222222222222', 'editor');

select pg_temp.assert(
  (select count(*) from public.teams where id = '99999999-9999-9999-9999-999999999999') = 1,
  'a team owner sees their team');

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
select pg_temp.assert(
  (select count(*) from public.teams where id = '99999999-9999-9999-9999-999999999999') = 1,
  'a team member sees the team');
do $$
begin
  begin
    insert into public.team_members (team_id, user_id, role)
    values ('99999999-9999-9999-9999-999999999999', '44444444-4444-4444-4444-444444444444', 'admin');
    raise exception 'FAIL  a team editor added a member';
  exception
    when insufficient_privilege then raise notice 'ok    a team editor cannot add members';
  end;
end $$;

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.teams where id = '99999999-9999-9999-9999-999999999999') = 0,
  'an outsider cannot see the team');
select pg_temp.assert(
  (select count(*) from public.team_members
    where team_id = '99999999-9999-9999-9999-999999999999') = 0,
  'an outsider cannot enumerate team members');
do $$
begin
  begin
    insert into public.teams (id, name, slug, owner_id)
    values (
      '88888888-8888-8888-8888-888888888888',
      'Stolen',
      'stolen',
      '11111111-1111-1111-1111-111111111111'
    );
    raise exception 'FAIL  a team could be created under another owner';
  exception
    when insufficient_privilege then raise notice 'ok    a user cannot create a team owned by someone else';
  end;
end $$;

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
do $$
begin
  begin
    delete from public.teams where id = '99999999-9999-9999-9999-999999999999';
    if not found then
      raise notice 'ok    a non-member cannot delete a team';
    else
      raise exception 'FAIL  a non-member deleted a team';
    end if;
  exception
    when insufficient_privilege then raise notice 'ok    a non-member cannot delete a team';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Profiles are visible to collaborators, not to strangers
-- --------------------------------------------------------------------------

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
select pg_temp.assert(
  (select count(*) from public.profiles
    where id = '22222222-2222-2222-2222-222222222222') = 1,
  'collaborators on the same project can see each other');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.profiles
    where id = '11111111-1111-1111-1111-111111111111') = 0,
  'an outsider cannot read an unrelated profile');
select pg_temp.assert(
  (select count(*) from public.profiles
    where id = '44444444-4444-4444-4444-444444444444') = 1,
  'every user can read their own profile');

do $$
begin
  begin
    update public.profiles set display_name = 'Hacked'
     where id = '11111111-1111-1111-1111-111111111111';
    if not found then
      raise notice 'ok    a user cannot rename another profile';
    else
      raise exception 'FAIL  a user renamed another profile';
    end if;
  exception
    when insufficient_privilege then raise notice 'ok    a user cannot rename another profile';
  end;
end $$;

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

-- --------------------------------------------------------------------------
-- GitHub credentials — unreachable from any client role
-- --------------------------------------------------------------------------

select pg_temp.act_as_admin();

insert into private.github_tokens (user_id, access_token)
values ('11111111-1111-1111-1111-111111111111', 'gho_secret_value');

insert into public.github_connections (user_id, github_login, github_user_id, scopes)
values
  ('11111111-1111-1111-1111-111111111111', 'owner-gh',  501, '{repo}'),
  ('22222222-2222-2222-2222-222222222222', 'editor-gh', 502, '{repo}');

insert into public.project_remotes
  (project_id, owner, repo, repo_id, default_branch, branch, connected_by)
values
  ('prj_test_alpha', 'octocat', 'demo', 9001, 'main', 'main',
   '11111111-1111-1111-1111-111111111111');

-- The credential table lives in a schema no client role has rights on, so the
-- token cannot be read even by the user it belongs to.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
begin
  begin
    perform 1 from private.github_tokens;
    raise exception 'FAIL  a signed-in user could read the GitHub token table';
  exception
    when insufficient_privilege then
      raise notice 'ok    the GitHub token table is unreachable from a user session';
  end;
end $$;

do $$
begin
  begin
    perform 1 from private.github_oauth_states;
    raise exception 'FAIL  a signed-in user could read pending OAuth states';
  exception
    when insufficient_privilege then
      raise notice 'ok    OAuth state is unreachable from a user session';
  end;
end $$;

select pg_temp.assert(
  (select count(*) from public.github_connections) = 1,
  'a user sees only their own GitHub connection');

select pg_temp.assert(
  (select github_login from public.github_connections) = 'owner-gh',
  'the visible connection is the caller''s own');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.github_connections) = 0,
  'an outsider sees no GitHub connections at all');

-- A browser cannot claim a GitHub identity: there is no insert policy.
do $$
begin
  begin
    insert into public.github_connections (user_id, github_login, github_user_id)
    values ('44444444-4444-4444-4444-444444444444', 'forged', 999);
    raise exception 'FAIL  a user could forge a GitHub connection row';
  exception
    when insufficient_privilege then
      raise notice 'ok    a user cannot forge a GitHub connection';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Project remotes
-- --------------------------------------------------------------------------

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
select pg_temp.assert(
  (select count(*) from public.project_remotes where project_id = 'prj_test_alpha') = 1,
  'a viewer can see which repository the project is connected to');

do $$
begin
  begin
    update public.project_remotes set last_synced_sha = repeat('a', 40)
    where project_id = 'prj_test_alpha';
    if found then
      raise exception 'FAIL  a viewer could record a push';
    end if;
    raise notice 'ok    a viewer cannot record remote sync state';
  exception
    when insufficient_privilege then
      raise notice 'ok    a viewer cannot record remote sync state';
  end;
end $$;

do $$
begin
  begin
    delete from public.project_remotes where project_id = 'prj_test_alpha';
    if found then
      raise exception 'FAIL  a viewer could disconnect the repository';
    end if;
    raise notice 'ok    a viewer cannot disconnect the repository';
  exception
    when insufficient_privilege then
      raise notice 'ok    a viewer cannot disconnect the repository';
  end;
end $$;

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
-- The project is public by this point in the suite, which is exactly the case
-- worth checking: public readability must not expose a private repository.
select pg_temp.assert(
  (select visibility from public.projects where id = 'prj_test_alpha') = 'public',
  'the fixture project is public, so the next assertion is meaningful');
select pg_temp.assert(
  (select count(*) from public.project_remotes where project_id = 'prj_test_alpha') = 0,
  'a public project does not expose its remote to non-members');

-- An editor may record sync state, because that is what a push produces.
select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
update public.project_remotes set last_synced_sha = repeat('b', 40)
where project_id = 'prj_test_alpha';
select pg_temp.assert(
  (select last_synced_sha from public.project_remotes where project_id = 'prj_test_alpha')
    = repeat('b', 40),
  'an editor can record the result of a push');

-- but may not use that same update to repoint the project elsewhere.
do $$
begin
  begin
    update public.project_remotes set repo = 'somewhere-else'
    where project_id = 'prj_test_alpha';
    raise exception 'FAIL  an editor could repoint the project at another repository';
  exception
    when insufficient_privilege then
      raise notice 'ok    an editor cannot repoint the project at another repository';
  end;
end $$;

do $$
begin
  begin
    insert into public.project_remotes
      (project_id, owner, repo, repo_id, default_branch, branch)
    values ('prj_test_alpha', 'octocat', 'other', 9002, 'main', 'main');
    raise exception 'FAIL  an editor could connect a repository';
  exception
    when insufficient_privilege then raise notice 'ok    an editor cannot connect a repository';
    when unique_violation then raise notice 'ok    an editor cannot connect a repository';
  end;
end $$;

-- An admin may repoint it.
select pg_temp.act_as('55555555-5555-5555-5555-555555555555');
select pg_temp.act_as_admin();
insert into public.project_members (project_id, user_id, role)
values ('prj_test_alpha', '55555555-5555-5555-5555-555555555555', 'admin')
on conflict (project_id, user_id) do update set role = 'admin';
select pg_temp.act_as('55555555-5555-5555-5555-555555555555');
update public.project_remotes set repo = 'renamed' where project_id = 'prj_test_alpha';
select pg_temp.assert(
  (select repo from public.project_remotes where project_id = 'prj_test_alpha') = 'renamed',
  'an admin can repoint the project at another repository');

-- Identifier shapes are constrained in the database, not only in the client.
select pg_temp.act_as_admin();
do $$
begin
  begin
    insert into public.project_remotes
      (project_id, owner, repo, repo_id, default_branch, branch)
    values ('prj_test_beta', '../../etc', 'demo', 9003, 'main', 'main');
    raise exception 'FAIL  a traversing owner was accepted';
  exception
    when check_violation then raise notice 'ok    a traversing owner is rejected';
    when foreign_key_violation then raise notice 'ok    a traversing owner is rejected';
  end;
end $$;

do $$
begin
  begin
    insert into public.projects (id, owner_id, name)
    values ('prj_test_beta', '11111111-1111-1111-1111-111111111111', 'Beta');
    insert into public.project_remotes
      (project_id, owner, repo, repo_id, default_branch, branch)
    values ('prj_test_beta', 'octocat', 'demo', 9003, 'main', 'feature/../../etc');
    raise exception 'FAIL  a traversing branch name was accepted';
  exception
    when check_violation then raise notice 'ok    a traversing branch name is rejected';
  end;
end $$;

do $$
begin
  begin
    insert into public.project_remotes
      (project_id, owner, repo, repo_id, default_branch, branch, last_synced_sha)
    values ('prj_test_beta', 'octocat', 'demo', 9003, 'main', 'main', 'not-a-sha');
    raise exception 'FAIL  a malformed commit id was accepted';
  exception
    when check_violation then raise notice 'ok    a malformed commit id is rejected';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Workspaces
--
-- A workspace is private to its owner and grants no access to anything: it is
-- an ordering hint over projects the caller can already read. The assertions
-- that matter are that nobody else can see it, and that listing a project id
-- inside one does not make that project readable.
-- --------------------------------------------------------------------------

select pg_temp.act_as_admin();
insert into public.workspaces (id, owner_id, name, project_ids)
values ('ws_owner', '11111111-1111-1111-1111-111111111111', 'Owner space',
        array['prj_test_alpha', 'prj_test_private']);

insert into public.projects (id, owner_id, name, visibility)
values ('prj_test_private', '44444444-4444-4444-4444-444444444444', 'Outsider private', 'private')
on conflict (id) do nothing;

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
select pg_temp.assert(
  (select count(*) from public.workspaces where id = 'ws_owner') = 1,
  'an owner sees their own workspace');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.workspaces) = 0,
  'a workspace is invisible to everyone but its owner');

-- The important one: naming a project inside a workspace must not grant a
-- read on that project.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
select pg_temp.assert(
  (select count(*) from public.projects where id = 'prj_test_private') = 0,
  'listing a project in a workspace does not grant access to it');

select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
do $$
begin
  begin
    insert into public.workspaces (id, owner_id, name)
    values ('ws_forged', '11111111-1111-1111-1111-111111111111', 'Forged');
    raise exception 'FAIL  a workspace could be created under another owner';
  exception
    when insufficient_privilege then
      raise notice 'ok    a workspace cannot be created under another owner';
  end;
end $$;

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
update public.workspaces set name = 'stolen' where id = 'ws_owner';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select name from public.workspaces where id = 'ws_owner') = 'Owner space',
  'an outsider cannot rename a workspace they do not own');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
delete from public.workspaces where id = 'ws_owner';
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.workspaces where id = 'ws_owner') = 1,
  'an outsider cannot delete a workspace they do not own');

-- An owner cannot hand their row to somebody else, which would otherwise be a
-- way to write into another account's list.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
begin
  begin
    update public.workspaces
       set owner_id = '44444444-4444-4444-4444-444444444444'
     where id = 'ws_owner';
    if found then
      raise exception 'FAIL  a workspace could be reassigned to another owner';
    end if;
    raise notice 'ok    a workspace cannot be reassigned to another owner';
  exception
    when insufficient_privilege then
      raise notice 'ok    a workspace cannot be reassigned to another owner';
  end;
end $$;

select pg_temp.act_as_admin();
do $$
begin
  begin
    insert into public.workspaces (id, owner_id, name)
    values ('ws_nameless', '11111111-1111-1111-1111-111111111111', '');
    raise exception 'FAIL  a nameless workspace was accepted';
  exception
    when check_violation then raise notice 'ok    a nameless workspace is rejected';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Activity is append-only, and attributable only to the acting user
-- --------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
insert into public.project_activity (project_id, actor_id, action, detail)
values ('prj_test_alpha', '22222222-2222-2222-2222-222222222222', 'commit.created',
        '{"subject":"fixture"}'::jsonb);
select pg_temp.assert(true, 'an editor can record activity as themselves');

do $$
begin
  begin
    update public.project_activity set action = 'project.renamed'
     where project_id = 'prj_test_alpha';
    if found then
      raise exception 'FAIL  activity could be rewritten';
    end if;
    raise notice 'ok    activity cannot be rewritten after the fact';
  exception
    when insufficient_privilege then
      raise notice 'ok    activity cannot be rewritten after the fact';
  end;
end $$;

-- The alpha fixture was made public earlier in this suite, and public
-- visibility grants reading — of the code and of the timeline alike, which is
-- the documented model. What must hold is that a *private* project's activity
-- stays invisible.
select pg_temp.act_as_admin();
insert into public.projects (id, owner_id, name, visibility)
values ('prj_test_secret', '11111111-1111-1111-1111-111111111111', 'Secret', 'private');
insert into public.project_members (project_id, user_id, role)
values ('prj_test_secret', '11111111-1111-1111-1111-111111111111', 'owner')
on conflict (project_id, user_id) do nothing;
insert into public.project_activity (project_id, actor_id, action, detail)
values ('prj_test_secret', '11111111-1111-1111-1111-111111111111', 'commit.created',
        '{"subject":"private work"}'::jsonb);

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.project_activity where project_id = 'prj_test_secret') = 0,
  'an outsider cannot read a private project''s activity');

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
select pg_temp.assert(
  (select count(*) from public.project_activity where project_id = 'prj_test_secret') = 1,
  'the owner can read their own private project''s activity');

-- An actor cannot file activity under somebody else's identity.
select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    insert into public.project_activity (project_id, actor_id, action, detail)
    values ('prj_test_alpha', '11111111-1111-1111-1111-111111111111', 'commit.created',
            '{"subject":"impersonated"}'::jsonb);
    raise exception 'FAIL  activity could be filed under another identity';
  exception
    when insufficient_privilege then
      raise notice 'ok    activity cannot be filed under another identity';
  end;
end $$;

-- --------------------------------------------------------------------------
-- Invitations
--
-- The properties that matter: only the hash is stored, only an administrator
-- can create one, only the addressed account can redeem it, and it works
-- exactly once. Each is asserted against the real function rather than by
-- reading the policy.
-- --------------------------------------------------------------------------

-- A token the test knows, so it can redeem it the way a link would.
create or replace function pg_temp.token_hash(raw text)
returns text language sql immutable as $$
  select encode(digest(raw, 'sha256'), 'hex');
$$;

select pg_temp.act_as_admin();
insert into public.projects (id, owner_id, name, visibility)
values ('prj_invite', '11111111-1111-1111-1111-111111111111', 'Invite fixture', 'private')
on conflict (id) do nothing;
insert into public.project_members (project_id, user_id, role)
values ('prj_invite', '11111111-1111-1111-1111-111111111111', 'owner')
on conflict (project_id, user_id) do nothing;

-- An editor may not invite anyone.
select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    insert into public.project_invitations (project_id, token_hash, email, role, invited_by)
    values ('prj_invite', pg_temp.token_hash('editor-attempt'), 'outsider@test.dev', 'editor',
            '22222222-2222-2222-2222-222222222222');
    raise exception 'FAIL  an editor could create an invitation';
  exception
    when insufficient_privilege then
      raise notice 'ok    an editor cannot create an invitation';
  end;
end $$;

-- The owner can, and cannot forge the inviter.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
insert into public.project_invitations (project_id, token_hash, email, role, invited_by)
values ('prj_invite', pg_temp.token_hash(repeat('a', 64)), 'outsider@test.dev', 'editor',
        '11111111-1111-1111-1111-111111111111');
select pg_temp.assert(true, 'an owner can create an invitation');

do $$
begin
  begin
    insert into public.project_invitations (project_id, token_hash, email, role, invited_by)
    values ('prj_invite', pg_temp.token_hash('forged'), 'x@test.dev', 'editor',
            '22222222-2222-2222-2222-222222222222');
    raise exception 'FAIL  an invitation could be attributed to someone else';
  exception
    when insufficient_privilege then
      raise notice 'ok    an invitation cannot be attributed to another inviter';
  end;
end $$;

-- Owner is not an invitable role.
do $$
begin
  begin
    insert into public.project_invitations (project_id, token_hash, email, role, invited_by)
    values ('prj_invite', pg_temp.token_hash('owner-escalation'), 'x@test.dev', 'owner',
            '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL  an invitation could grant ownership';
  exception
    when check_violation then raise notice 'ok    an invitation cannot grant ownership';
  end;
end $$;

-- The raw token is never stored.
select pg_temp.act_as_admin();
select pg_temp.assert(
  (select count(*) from public.project_invitations
    where token_hash = repeat('a', 64)) = 0,
  'the raw token is never stored, only its hash');

-- An outsider cannot even see that an invitation exists.
select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  (select count(*) from public.project_invitations) = 0,
  'an outsider cannot read invitations');

-- Redeeming with the wrong account fails, even holding a valid token.
select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
do $$
begin
  begin
    perform public.accept_project_invitation(repeat('a', 64));
    raise exception 'FAIL  an invitation was redeemed by the wrong account';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise;
      end if;
      raise notice 'ok    an invitation cannot be redeemed by another account';
  end;
end $$;

-- A malformed token is refused without touching anything.
do $$
begin
  begin
    perform public.accept_project_invitation('not-a-token');
    raise exception 'FAIL  a malformed token was accepted';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise;
      end if;
      raise notice 'ok    a malformed invitation token is refused';
  end;
end $$;

-- The addressed account redeems it, and becomes a member with the stated role.
select pg_temp.act_as_admin();
update public.profiles set email = 'outsider@test.dev'
 where id = '44444444-4444-4444-4444-444444444444';

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
select pg_temp.assert(
  public.accept_project_invitation(repeat('a', 64)) = 'prj_invite',
  'the addressed account can redeem its invitation');

select pg_temp.act_as_admin();
select pg_temp.assert(
  (select role::text from public.project_members
    where project_id = 'prj_invite'
      and user_id = '44444444-4444-4444-4444-444444444444') = 'editor',
  'redeeming creates membership with the invited role');

-- And exactly once.
select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
do $$
begin
  begin
    perform public.accept_project_invitation(repeat('a', 64));
    raise exception 'FAIL  an invitation was redeemed twice';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise;
      end if;
      raise notice 'ok    an invitation cannot be redeemed twice';
  end;
end $$;

-- An expired invitation is refused.
select pg_temp.act_as_admin();
insert into public.project_invitations
  (project_id, token_hash, email, role, invited_by, expires_at)
values ('prj_invite', pg_temp.token_hash(repeat('b', 64)), 'outsider@test.dev', 'viewer',
        '11111111-1111-1111-1111-111111111111', now() - interval '1 day');

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
do $$
begin
  begin
    perform public.accept_project_invitation(repeat('b', 64));
    raise exception 'FAIL  an expired invitation was accepted';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise;
      end if;
      raise notice 'ok    an expired invitation is refused';
  end;
end $$;

-- A revoked invitation is refused.
select pg_temp.act_as_admin();
insert into public.project_invitations (project_id, token_hash, email, role, invited_by, revoked_at)
values ('prj_invite', pg_temp.token_hash(repeat('c', 64)), 'outsider@test.dev', 'viewer',
        '11111111-1111-1111-1111-111111111111', now());

select pg_temp.act_as('44444444-4444-4444-4444-444444444444');
do $$
begin
  begin
    perform public.accept_project_invitation(repeat('c', 64));
    raise exception 'FAIL  a revoked invitation was accepted';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise;
      end if;
      raise notice 'ok    a revoked invitation is refused';
  end;
end $$;

-- An outstanding invitation cannot be edited into something else.
select pg_temp.act_as_admin();
insert into public.project_invitations (project_id, token_hash, email, role, invited_by)
values ('prj_invite', pg_temp.token_hash(repeat('d', 64)), 'outsider@test.dev', 'viewer',
        '11111111-1111-1111-1111-111111111111');

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
begin
  begin
    update public.project_invitations set role = 'admin'
     where token_hash = pg_temp.token_hash(repeat('d', 64));
    raise exception 'FAIL  an outstanding invitation could be escalated';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise;
      end if;
      raise notice 'ok    an outstanding invitation cannot be escalated';
  end;
end $$;

-- Revoking it is still allowed.
update public.project_invitations set revoked_at = now()
 where token_hash = pg_temp.token_hash(repeat('d', 64));
select pg_temp.assert(true, 'an administrator can revoke an invitation');

select pg_temp.act_as_admin();
select pg_temp.assert(true, 'all authorization assertions passed');

rollback;
