# Forge IDE

A browser-based development environment: the Monaco editor, a real bundler, a
working shell, version control and a sandboxed live preview — all running client
side, with nothing to install.

Forge is built on one rule: **every visible feature either works, or says
plainly that it cannot.** Where a browser genuinely cannot do something (bind a
TCP port, talk to a git remote, populate `node_modules`), the UI states the
limitation instead of miming the behaviour.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Supabase setup](#supabase-setup)
- [Database migrations](#database-migrations)
- [Local development](#local-development)
- [Production build](#production-build)
- [Deployment](#deployment)
- [Security notes](#security-notes)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Honest limitations](#honest-limitations)

---

## What it does

| Area | What is actually implemented |
| --- | --- |
| **Editor** | Monaco with language workers, IntelliSense, folding, multi-cursor, find/replace, go-to-symbol, breadcrumbs, split view, per-file view state, format-on-save. |
| **Build** | `esbuild-wasm` compiles the project's real source in a worker. Diagnostics carry file, line and column, and clicking one jumps there. |
| **Preview** | A sandboxed iframe (`allow-scripts` only, no `allow-same-origin`). Console output, runtime errors and unhandled rejections are piped back. Device presets, refresh, open-in-tab. |
| **Terminal** | xterm.js over *Forge Shell*, a command interpreter that mutates the real virtual file system. History, tab completion, multiple sessions. |
| **Version control** | *Forge VCS*: content-addressed blobs, commits, branches, staging, three-way merge with conflict markers, line-level diff viewer. |
| **Search** | Project-wide search in a worker: regex, whole word, case, include/exclude globs, replace across files. |
| **Packages** | Live npm registry search and version resolution, written into `package.json`; the preview imports those exact versions from a CDN. |
| **AI assistant** | An agent loop over nine real tools. Bring your own provider; every tool call and its result are shown. |
| **Auth** | Supabase email/password plus Google and GitHub OAuth, with a graceful Local Development Mode when Supabase is absent. |
| **Import/export** | ZIP in and out, plus import from a public GitHub repository. Traversal and sensitive paths are blocked at the boundary. |

---

## Architecture

### The file system is path-based

A project is a flat `Record<path, content>` map plus a list of explicit
directory paths. This mirrors how esbuild, ZIP archives and git address files,
and it removes the id/parent bookkeeping that makes tree mutations error prone.

Every path that enters the workspace — from the UI, an archive, the shell or an
AI tool — passes through `normalizePath` in `src/lib/vfs.ts`. That single choke
point rejects traversal, absolute paths, Windows separators, control characters
and reserved device names. Nothing else is trusted to sanitise a path.

### State is split by concern

Ten small Zustand stores, not one object:

```
authStore      session and provider
projectStore   project list and metadata CRUD
fileStore      working tree for the open project, dirty tracking, autosave
editorStore    tabs, active file, cursor, problems, reveal requests
terminalStore  shell sessions and scrollback
previewStore   build status and the generated preview document
gitStore       Forge VCS state, status and history
aiStore        assistant transcript and provider config
consoleStore   the output/console buffer
uiStore        panel geometry and overlays
settingsStore  editor, appearance, runtime and keybindings
```

Only geometry and preferences are persisted to `localStorage`; project content
lives in IndexedDB or Postgres.

### Storage is behind one interface

```
ProjectRepository
├── localRepository     IndexedDB — always available, used in Local Mode
└── supabaseRepository  Postgres behind row level security
```

Stores never branch on which backend is active. `repositoryFor(provider)` picks
one. If IndexedDB itself is unavailable (private mode, restricted webview) the
helper falls back to an in-memory map and the Settings page reports that
persistence is off, rather than silently losing work.

### The preview pipeline

```
files ──► findEntry() ──► esbuild-wasm ──► bundle + CSS
                                │
                                ├─ relative imports resolved from the VFS
                                └─ bare imports left external
                                          │
                       import map ────────┘   (esm.sh or jsDelivr, version
                                               pinned from package.json)
                                          │
                          assembled HTML ─┴──► sandboxed iframe (srcdoc)
                                                       │
                                       postMessage bridge ──► Output panel
```

The iframe has no `allow-same-origin`, so it runs in an opaque origin: project
code cannot read the IDE's storage, cookies or DOM. Messages are accepted only
when `event.source` is that exact frame.

### Forge VCS

Not git, and it does not claim to be. It is a snapshot engine with the concepts
the IDE needs: a blob store keyed by content hash, commits with parents,
branches, a staging index, status, diff and per-file three-way merge. It is
fully offline and stored with the project. Push, pull and clone against a git
remote are not implemented — that needs a smart-HTTP client and credentials the
browser should not hold — and the panel says so.

### The AI agent

`runAgent` is a tool-use loop. The model is asked, its tool calls are executed
against the real workspace, and the real results are fed back. Write tools are
filtered out for read-only roles *and* re-checked at call time, so naming a tool
the model was not offered still fails. Activity rows appear only after the
corresponding call returns.

---

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| UI | React 18 + TypeScript (strict) | Familiar, typed, no compiler required. |
| Build | Vite 7 | Fast dev server, worker and wasm asset handling. |
| Editor | `monaco-editor` bundled locally | Works offline and under a strict content policy; no CDN dependency. |
| Bundler | `esbuild-wasm` | Real compilation in the browser, not a transpile-only shim. |
| Terminal | `@xterm/xterm` | The de-facto browser terminal. |
| State | Zustand | Small, unopinionated, easy to slice. |
| Styling | Tailwind over CSS variables | One `data-theme` attribute swaps the palette; opacity modifiers still work. |
| Icons | `lucide-react` | Consistent, tree-shakeable. |
| Archives | `jszip` | Import/export. |
| Backend | Supabase (Postgres, Auth, RLS) | Auth and row-level authorization without a bespoke server. |

Nothing else is a dependency.

---

## Installation

Requires **Node 20.19+** (Vite 7).

```bash
git clone <your-fork> forge-ide
cd forge-ide
npm install
cp .env.example .env      # optional — see below
npm run dev
```

Open http://localhost:5173. With no `.env`, the app starts in Local Development
Mode: click **Continue in Local Mode** on the sign-in page and everything works,
stored in your browser.

---

## Environment variables

Both are optional. See `.env.example`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | No | Supabase project URL. Absent ⇒ Local Development Mode. |
| `VITE_SUPABASE_ANON_KEY` | No | Supabase **anon/publishable** key. |

The anon key is embedded in the client bundle by design: on its own it grants
nothing, because every table is protected by row level security.

**Never set a service-role key here.** It bypasses RLS, and anything prefixed
`VITE_` ships to every visitor. Forge inspects the key's JWT payload at startup
and refuses to use one that carries `role: service_role`, logging an error
instead.

The AI provider key is *not* an environment variable. It is entered in the
assistant panel and held in `sessionStorage` for that tab only — never
persisted, never synced, never sent anywhere but your chosen provider.

---

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Copy the project URL and the anon key into `.env`.
3. Apply the migration (below).
4. **Auth → URL Configuration**: add `http://localhost:5173/auth/callback` and
   your production equivalent to the redirect allow list.
5. **Auth → Providers**: enable Google and/or GitHub and paste in their client
   credentials. Their callback URL is the Supabase-provided
   `https://<project>.supabase.co/auth/v1/callback`, not your app's.

The app uses the PKCE flow, so no client secret ever reaches the browser.

---

## Database migrations

`supabase/migrations/0001_init.sql` is idempotent and safe to re-run.

With the Supabase CLI:

```bash
supabase link --project-ref <ref>
supabase db push
```

Or directly:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql
```

Tables: `profiles`, `teams`, `team_members`, `projects`, `project_members`,
`project_files`, `project_settings`, `project_vcs`, `project_activity` — each
with primary keys, foreign keys with explicit cascade behaviour, indexes on
every column policies filter by, check constraints, timestamps and RLS.

---

## Local development

```bash
npm run dev          # dev server on :5173
npm run typecheck    # tsc --noEmit, strict
npm run lint         # eslint
npm run test         # vitest
npm run test:watch
npm run test:coverage
npm run build        # typecheck, then production build
npm run preview      # serve the production build
npm run verify       # typecheck + lint + test + build
```

---

## Production build

```bash
npm run build
```

Output lands in `dist/`. The build is code split so the landing page does not
pay for the IDE:

| Chunk | Size (gzip) | Loaded when |
| --- | --- | --- |
| initial app | ~110 KB | always |
| Monaco | ~3.2 MB raw | first editor mount |
| language workers | on demand | per language |
| `esbuild.wasm` | ~9 MB | first build |
| workspace route | ~119 KB | opening a project |

Monaco and its workers are bundled and served from your own origin, so the app
works offline and under a restrictive content security policy.

---

## Deployment

Any static host works — the app is a single-page application with no server
component.

- Serve `dist/` and rewrite unknown paths to `/index.html` (client routing).
- Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at build time; Vite
  inlines them, so they must be present when `npm run build` runs.
- Add your deployed origin to the Supabase redirect allow list.
- If you set a Content-Security-Policy, allow `worker-src blob:` (Monaco and
  esbuild), `wasm-unsafe-eval` (esbuild), and whichever package CDN you have
  selected in Settings → Runtime.

---

## Security notes

Threats considered, and what answers each:

| Risk | Mitigation |
| --- | --- |
| **Path traversal** | One `normalizePath` choke point rejects `..`, absolute paths, backslashes, control characters and reserved names. ZIP entries are re-normalised on import. Postgres check constraints reject traversing paths independently. |
| **Broken access control / IDOR** | Reads and writes are scoped by RLS policies, never by client-side filters. Requesting another user's project id returns nothing. |
| **Privilege escalation** | An editor cannot promote themselves: the `project_members` policy only lets admins write, and only an owner may grant the owner role. Ownership transfer is guarded by a trigger. |
| **XSS** | React escapes by default; there is no `dangerouslySetInnerHTML` anywhere. Preview scaffolding uses explicit escaping. |
| **Untrusted code execution** | The preview iframe is sandboxed without `allow-same-origin`, so it has an opaque origin and no access to IDE storage or DOM. `postMessage` is validated by source. |
| **Command injection** | The shell is an interpreter over the virtual file system, not a process spawner. There is no host to inject into. |
| **Secret exposure** | Only the anon key ships to the client, and a service-role key is detected and refused. The AI key lives in `sessionStorage` only. `.env` and other secret paths are excluded from both import and export. |
| **Unsafe archives** | Imports are capped (3000 files, 2 MB per file, 40 MB total), text-only, and screened against a blocked-path policy that covers `.git/`, `.env`, `node_modules/`, `.ssh/`, `.npmrc` and build output. |
| **Append-only audit** | `project_activity` has insert and select policies but no update or delete, and an actor may only file activity under their own id. |
| **Policy recursion** | Membership lookups run through `SECURITY DEFINER` helpers with a pinned `search_path`, so policies cannot recurse or be hijacked. |

Client-side permission checks exist to render the right affordances. They are
not the boundary — the database is.

---

## Testing

```bash
npm run test
```

192 unit and integration tests cover the parts where a mistake is expensive:

| Suite | Focus |
| --- | --- |
| `lib/vfs.test.ts` | Path normalisation, traversal rejection, sensitive-path policy, tree building. |
| `lib/vcs.test.ts` | Staging, commits, branches, checkout guards, fast-forward, merge, conflicts. |
| `lib/diff.test.ts` | Line diff correctness and three-way merge, including conflict markers. |
| `lib/search.test.ts` | Regex and literal search, glob filters, replace semantics, fuzzy ranking. |
| `lib/archive.test.ts` | ZIP import traversal defence, blocked paths, binary handling, round trip. |
| `lib/permissions.test.ts` | Role capabilities and AI tool gating, including a read-only caller naming a write tool. |
| `lib/shell.test.ts` | Command behaviour, path resolution, and that unknown commands are refused rather than faked. |
| `lib/packages.test.ts` | Manifest parsing, name validation, registry error handling. |
| `lib/preview.test.ts` | Entry detection, dependency pinning, template integrity. |
| `stores/stores.test.ts` | Project lifecycle, file operations, persistence, tab behaviour, VCS integration, read-only enforcement. |

### End-to-end

`e2e/smoke.mjs` drives a real browser through sign-in, project creation, the
editor, a genuine build and preview, the shell, search, version control, the
command palette, the Problems panel, settings and the mobile layout. It fails on
any uncaught page error or console error, so a runtime-only regression still
breaks the run.

Playwright is not an app dependency, so install it first:

```bash
npm i -D playwright && npx playwright install chromium
npm run dev            # in another shell
npm run test:e2e
```

Screenshots land in `e2e/artifacts/`.

### Authorization tests

RLS boundaries are tested in SQL, where they are actually enforced:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
```

The script creates an owner, an editor, a viewer and an outsider, then asserts —
as each of them, with a real `auth.uid()` — that reads are scoped, viewers
cannot write, editors cannot escalate or delete, outsiders see nothing, public
visibility grants read but never write, and activity cannot be attributed to
someone else. Everything rolls back at the end.

---

## Project structure

```
src/
  components/
    ui/            design system: Button, IconButton, Field, Modal, Menu,
                   Toast, Tooltip, Resizer, Primitives
    landing/       marketing page pieces
    dashboard/     project creation and import dialogs
    ide/           ActivityBar, FileExplorer, SearchPanel, GitPanel,
                   PackagesPanel, AssistantPanel, MembersPanel, CodeEditor,
                   EditorTabs, PreviewPanel, TerminalView, BottomPanel,
                   StatusBar, CommandPalette, DiffViewer
  hooks/           useTheme, useKeyboardShortcuts, useMediaQuery
  lib/
    vfs.ts         path normalisation and the tree model  ← security choke point
    bundler.ts     esbuild-wasm wrapper
    preview.ts     preview document assembly and the sandbox bridge
    shell.ts       command interpreter (pure)
    shellHost.ts   binds the interpreter to live stores
    vcs.ts         Forge VCS engine
    diff.ts        LCS diff and three-way merge
    search.ts      search, glob and replace
    packages.ts    npm registry client
    archive.ts     ZIP import/export and GitHub import
    permissions.ts role capabilities
    monaco.ts      Monaco setup, themes and workers
    idb.ts         IndexedDB wrapper with in-memory fallback
    supabase.ts    client, with service-role key detection
    ai/            provider, tools, agent loop
    repo/          ProjectRepository + local and Supabase implementations
    templates/     project templates
  routes/          LandingPage, AuthPage, DashboardPage, WorkspacePage,
                   SettingsPage
  stores/          the eleven state slices
  workers/         search.worker.ts
supabase/
  migrations/      schema, policies, triggers
  tests/           RLS authorization assertions
```

---

## Honest limitations

These are deliberate, and the UI says so where a user would otherwise be misled:

- **No `node_modules`.** Installing records the resolved version in
  `package.json`; the preview loads that version from a CDN. Packages relying on
  Node built-ins or install scripts will not run.
- **No git remote.** Forge VCS is local. Use Export ZIP to move work out, or
  Import from GitHub to bring a public repository in.
- **Node and Next.js templates cannot preview.** They need a server process.
  Editing, search, version control and export work normally; the preview panel
  explains why it is unavailable rather than showing a blank frame.
- **The shell is not a POSIX shell.** `help` lists exactly what is implemented.
  Anything else returns `command not found` instead of plausible output.
- **The assistant needs your own provider.** Without one the panel says it is
  not connected. Nothing is generated locally.
- **Collaboration is schema-complete, not live.** Members, teams, roles and
  activity ship with enforced policies; real-time multi-cursor editing does not
  exist yet and is not advertised as if it does.
