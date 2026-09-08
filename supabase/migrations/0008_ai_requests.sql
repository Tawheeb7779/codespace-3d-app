-- TA CODE — the hosted assistant's usage ledger.
--
-- The deployment holds one Gemini key for everybody, so "who has spent what,
-- recently" stops being bookkeeping and becomes the only thing standing between
-- one signed-in account and the whole bill. It lives here rather than in the
-- function's memory because Edge Functions are per-request isolates: a counter
-- in a module variable resets whenever a new one starts, which is exactly when
-- somebody hammering the endpoint would benefit from it resetting.
--
-- One row per accepted request. `user_id` is written from the JWT the function
-- verified, never from the request body, so a client cannot file its usage
-- under someone else's name — and because no client can write here at all, it
-- cannot file usage anywhere.

create table if not exists public.ai_requests (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users (id) on delete cascade,
  created_at       timestamptz not null default now(),
  model            text        not null,
  -- Sizes, not content. The prompt carries the user's source code and the
  -- reply carries the assistant's answer; neither belongs in a table whose
  -- only job is counting, and storing them would put project code somewhere
  -- the project's own RLS does not reach.
  request_bytes    integer     not null default 0,
  response_bytes   integer     not null default 0,
  -- The upstream status, so an operator can tell a rate limit from an outage.
  upstream_status  integer,
  constraint ai_requests_model_length check (char_length(model) between 1 and 200),
  constraint ai_requests_sizes_sane check (request_bytes >= 0 and response_bytes >= 0)
);

-- The only query this table serves: "how many rows for this user since T".
create index if not exists ai_requests_user_time_idx
  on public.ai_requests (user_id, created_at desc);

alter table public.ai_requests enable row level security;

-- Readable by the person it is about, so a usage display never needs a server
-- round trip and never sees anybody else. There is deliberately no insert,
-- update or delete policy: only the service role writes here, which means a
-- signed-in user cannot forge usage, erase their own, or spend someone else's
-- allowance by deleting rows.
drop policy if exists ai_requests_select_self on public.ai_requests;
create policy ai_requests_select_self on public.ai_requests
  for select to authenticated using (user_id = auth.uid());

-- SELECT and nothing else. A policy alone would not be enough: a policy filters
-- rows a role already has the privilege to touch, so the privilege is where
-- "cannot write" is actually decided. Without the grant the select policy would
-- be decorative too — the table is new, so `authenticated` starts with nothing.
grant select on public.ai_requests to authenticated;
revoke insert, update, delete on public.ai_requests from authenticated;
revoke all on public.ai_requests from anon;
