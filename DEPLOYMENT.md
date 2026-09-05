# Deploying Forge IDE

Forge is a static single-page application. The build output in `dist/` is
plain files; there is no server component except the Supabase Edge Functions,
which deploy separately.

```
npm ci
npm run build      # typecheck, then vite build -> dist/
```

## 1. The one hosting requirement: SPA fallback

Forge uses history routing (`/dashboard`, `/project/:id`, `/invite`,
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
| `X-Frame-Options` | `DENY` | Forge is not meant to be framed. |

**Do not set `Cross-Origin-Embedder-Policy`.** Forge does not use
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
security. Forge refuses to start if it is handed a service-role key, and says
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
