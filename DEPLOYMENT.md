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
