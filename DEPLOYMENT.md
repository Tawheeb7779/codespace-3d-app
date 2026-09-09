# Deploying TA CODE

TA CODE is a static single-page application. The build output in `dist/` is
plain files; there is no server component except the Supabase Edge Functions,
which deploy separately.

```
npm ci
npm run build      # typecheck, then vite build -> dist/
```

## 1. The one hosting requirement: SPA fallback

TA CODE uses history routing (`/dashboard`, `/project/:id`, `/invite`,
`/settings/github/callback`). A static host that does not rewrite unknown
paths to `index.html` will return 404 on refresh and break every deep link —
including the GitHub OAuth callback and invitation links, which are only ever
opened as deep links.

`public/_redirects` covers Netlify and hosts that read the same file. For
others:

**Vercel** — `vercel.json` in this repository.

**nginx**

```nginx
location / {
  try_files $uri $uri/ /index.html;
}

# Hashed assets are immutable; index.html must never be cached, or a
# deployment leaves browsers loading old JavaScript against a new API.
location /assets/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
location = /index.html {
  add_header Cache-Control "no-cache";
}
```

**Caddy**

```
handle {
  try_files {path} /index.html
  file_server
}
```

## 2. Headers

Set these:

| Header | Value | Why |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | The preview serves user code; never let a response be re-interpreted. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Invitation tokens live in the URL fragment, which is never sent — this covers the rest. |
| `X-Frame-Options` | `DENY` | TA CODE is not meant to be framed. |

**Do not set `Cross-Origin-Embedder-Policy`.** TA CODE does not use
`SharedArrayBuffer`: esbuild-wasm runs in an ordinary Web Worker
(`worker: true`, no shared memory), so cross-origin isolation buys nothing —
and COEP would block the preview from fetching packages from esm.sh or
jsDelivr, which is a feature people actually use.

The preview itself is already isolated: it renders into a sandboxed
`<iframe srcdoc>`, so user code never shares an origin with the IDE.

## 3. Environment

Only two variables reach the browser, and both are safe there:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon / publishable key>
```

The anon key grants nothing on its own — every table is behind row level
security. TA CODE refuses to start if it is handed a service-role key, and says
why.

With neither set the app runs in **Local Development Mode**: a browser-local
account, projects in IndexedDB, and the UI labelled accordingly. That is a
supported mode, not a degraded one.

Anything secret belongs to the Edge Functions, never to `VITE_*`:

```
supabase secrets set GITHUB_CLIENT_ID=...
supabase secrets set GITHUB_CLIENT_SECRET=...
supabase secrets set FORGE_APP_ORIGIN=https://your-deployment.example
supabase functions deploy github-oauth
supabase functions deploy github-proxy
```

Register the GitHub OAuth app with callback
`<FORGE_APP_ORIGIN>/settings/github/callback`.

### The shared assistant

Gemini is provided by the deployment, so signed-in users never enter a key.
One secret and one function:

```
supabase secrets set GEMINI_API_KEY=...
supabase functions deploy ai-proxy
```

`ai-proxy` verifies the caller's Supabase session, enforces a per-user rate
limit against the `ai_requests` table (migration `0008`), caps the request and
the reply, and only then attaches the key. Optional settings, all with working
defaults:

| Secret | Default | What it does |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-2.5-flash` | The model used when the client asks for none. |
| `GEMINI_ALLOWED_MODELS` | the above | Comma-separated allowlist. Anything else is a 400. |
| `AI_RATE_LIMIT_PER_MINUTE` | `60` | Per user. One agent turn is up to 12 calls, so this is roughly five turns a minute. |
| `AI_RATE_LIMIT_PER_DAY` | `1500` | Per user. |
| `AI_MAX_REQUEST_BYTES` | `524288` | Bodies above this are refused with 413. |
| `AI_MAX_OUTPUT_TOKENS` | `4096` | The cap the server sets on every completion. |
| `AI_MAX_MESSAGES` | `200` | Longest conversation accepted. |

Changing a secret takes effect on the next `functions deploy`.

Without `GEMINI_API_KEY` the function answers 503 and says the deployment is
not configured; nothing else breaks, and the other providers are unaffected.

## 3b. The container gateway (optional)

The **Linux Container** terminal needs a service that a static host cannot
provide: long-lived WebSockets, a container runtime and a writable disk. It is
a separate deployment, and TA CODE works without it — with no gateway
configured the terminal is the virtual one and nothing else changes.

```
Frontend            Vercel (static)
Auth + database     Supabase
Edge Functions      Supabase (github-oauth, github-proxy, ai-proxy)
Container gateway   a Linux host you control, with Docker
Containers          ta-code/workspace:1, one per user per project
```

On the gateway host:

```
docker build -t ta-code/workspace:1 docker/workspace
cd gateway && npm ci

SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
TACODE_WORKSPACE_ROOT=/var/lib/ta-code/workspaces \
TACODE_ALLOWED_ORIGINS=https://your-deployment.example \
npm start
```

Note what is *not* in that command. `TACODE_NETWORK` is left unset, so
containers start with no outbound access at all — see below before changing it.

Then rebuild the frontend with `VITE_CONTAINER_GATEWAY_URL=wss://gateway.example`
— a URL, not a credential, and the only thing the browser needs to know.

Two settings deserve a decision rather than a default.

`TACODE_NETWORK` is `none` unless you set it, and it is left out of the command
above on purpose. `none` means a container has no outbound access at all: it
cannot reach the internet, the host, the gateway, your database, or the cloud
metadata endpoint that anything hostile in a container reaches for first. It is
also the setting where `npm install` does not work, so the pressure to set
`full` is constant and it should be a decision somebody made rather than a line
copied from a README.

`full` gives the container a bridge network, which means outbound access to
everything the host can reach — including services on your private network that
have no authentication because they were never meant to be reachable. If you
set it, put the gateway host somewhere that egress is filtered, and treat
everything running in a workspace as code you did not write, because it is.

`TACODE_ALLOWED_ORIGINS` should always be set in production — a WebSocket is
not subject to the same-origin policy, so without it any page a signed-in user
visits can open a terminal in their workspace.

The gateway must run as a service that can be restarted; it stops its
containers on `SIGTERM`, and containers that outlive their gateway are the
orphans the lifecycle design exists to prevent. `gateway/README.md` has the
full configuration table.

Apply migration `0009` for the workspace metadata table before enabling this.

## Diagnosing "the owner can sign in and nobody else can"

**Start here: apply migration `0010`.** A defect in this repository produced
exactly this symptom, and it is fixed by that migration.

`on_auth_user_created` mirrors new accounts into `profiles`. It is an AFTER
INSERT trigger on `auth.users`, so it runs inside the transaction that creates
the account: when it raised, the account was rolled back and never created at
all. Supabase reports that to the browser as **"Database error saving new
user"**. Anyone who already had a row — the person who set the project up — was
unaffected forever after, because their account was not being created again.

Two inputs made it raise, both confirmed by running them against this schema on
a real PostgreSQL:

| Input | Why it failed |
| --- | --- |
| `full_name: ""` | `coalesce` skips NULL, not the empty string, so an empty display name from an OAuth provider reached the length constraint with zero characters. |
| a name longer than 80 characters | Nothing clamped it, so a real Google display name over the limit violated the same constraint. |

Migration `0010` makes the derivation total, clamps the length, wraps the whole
trigger so no future constraint can block account creation, and backfills
profiles for any account created while it was failing. Apply it before
investigating anything else:

```
supabase db push        # or: psql "$DATABASE_URL" -f supabase/migrations/0010_profile_bootstrap.sql
```

### Verifying it, which needs a second person

The repository cannot prove this from here. The check is:

1. Apply migration `0010` to the production database.
2. On a **different device**, in a **private window**, open the production URL.
3. Sign up with an email address that has never been used on this deployment.
4. Confirm the account is created — no "Database error saving new user".
5. Sign in, and confirm a project can be created (which proves the `profiles`
   row exists, since every table has a foreign key to it).
6. Repeat with Google sign-in if it is enabled, because a first OAuth sign-in is
   also an INSERT into `auth.users` and took the same path.

If step 3 still fails, the cause is remote configuration rather than the schema,
and the rest of this section separates the possibilities.

### If it is not the schema

The asymmetry is still the clue. Both people load the same bundle, against the same Supabase project,
over the same origin. What differs is the *state of the second account*, so the
cause is in the Supabase dashboard rather than in this repository.

Work through it in this order. Each step distinguishes causes rather than
guessing at them, and the second person's error message is the input to all of
them — take it verbatim, since the app passes Supabase's own wording through
untouched precisely so this is possible.

0. **"Database error saving new user"** — the schema fault above. Apply `0010`.

1. **"Email not confirmed"** — Authentication → Providers → Email has "Confirm
   email" on, and the confirmation never arrived. Supabase's built-in SMTP is
   rate-limited to a handful of messages an hour and is not for real users, so
   this is the single most common answer. Configure a real SMTP provider under
   Authentication → Emails, or turn confirmation off if that suits the product.
   The owner does not hit it because their account predates the setting or was
   confirmed by hand.

2. **"Signups not allowed for this instance"** — Authentication → Sign In / Up
   has sign-ups disabled. The owner already has an account; nobody else can make
   one.

3. **Google sign-in returns to the app still signed out** — two separate
   causes, told apart by where the browser lands:
   - Back at TA CODE with no session: the production origin is missing from
     Authentication → URL Configuration → Redirect URLs. The app asks for
     `<origin>/auth/callback`, and Supabase silently falls back to the Site URL
     when the requested redirect is not on the allowlist. Add both the exact
     production origin and `<origin>/auth/callback`.
   - A Google error page about access: the OAuth consent screen is still in
     Testing, which admits only the accounts listed as test users — the owner,
     and nobody they send the link to. Publish the consent screen, or add the
     other person as a test user.

4. **"Could not reach the authentication service at …"** — this message names
   the host the deployed bundle is actually configured with. If that host is not
   your project, `VITE_SUPABASE_URL` on Vercel is wrong or was set after the
   last build: these are build-time values, baked into the bundle, so changing
   them in the Vercel dashboard does nothing until a redeploy. Check the
   Production environment specifically, not just Preview.

Two things this is *not*, and both are worth ruling out cheaply so nobody spends
a day on them. It is not CORS: Supabase serves the auth endpoints with
permissive CORS and a misconfiguration there would break the owner too. And it
is not session persistence: the client uses `persistSession` with PKCE, and a
failure to persist would show as being signed out on reload, not as being unable
to sign in at all.

## 4. Database

Apply migrations in order — they are idempotent, so re-running is safe:

```
supabase db push          # or: psql "$DATABASE_URL" -f supabase/migrations/*.sql
```

Then verify the deployed schema actually matches what the app queries, and
that authorization holds:

```
DATABASE_URL=... node scripts/check-schema-conformance.mjs
DATABASE_URL=... npm run test:rls
```

Both run against a real database. `check-schema-conformance` fails if a column
the client uses is missing, if row level security is off anywhere, if `anon`
has any grant, or if the GitHub token tables have escaped the `private` schema.

## 5. After deploying

- Sign in and confirm the badge reads **Cloud**, not **Local Mode**.
- Create a project, reload, confirm it persists.
- Connect GitHub in Settings → Integrations and import a repository.
- Invite an address you control; confirm the link works once and then does not.
