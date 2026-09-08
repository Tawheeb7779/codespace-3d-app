# TA CODE

A browser IDE: Monaco, a virtual filesystem, an in-browser bundler, a real git
implementation, a terminal, a live preview, and an AI agent with tools. React 18
+ TypeScript (strict) + Vite + Tailwind + Zustand. Supabase is optional — with no
credentials the app runs in Local Development Mode against IndexedDB.

`README.md` is the architecture and security reference. Read it before changing
persistence, GitHub, or the preview sandbox.

## Commands

| | |
|---|---|
| `npm run verify` | typecheck, lint, both audits, unit tests, build — the gate |
| `npm run dev` | dev server |
| `npm test` | unit tests (vitest, jsdom) |
| `npm run audit:contrast` | WCAG + hue separation over the palette |
| `npm run audit:reconciliation` | scans for the text-node crash described below |

Browser suites are `e2e/*.mjs`, run against a built `dist` served by
`npx vite preview`. Two need a stub server up first: `e2e/agent.mjs` needs
`npm run agent:test-provider`, `e2e/github.mjs` needs `npm run github:test-api`.
Both stubs are servers, not suites — running them as tests hangs.

## House rules

**Never report a success you have not observed.** A save is not saved until the
write is verified; a migration is not applied unless you applied it. Several
guards here exist because a silent failure looked like success:
`assertWrote` in the Supabase repository, `reportSaveFailure` in the file store.
Keep that property when you touch them.

**Security invariants** — do not weaken, and see `README.md` for why each exists:
preview sandbox without `allow-same-origin`; `postMessage` source verification;
`noopener` on popups; GitHub tokens server-side only, never in `VITE_*`;
`normalizePath` as the single path choke point; Supabase RLS and ownership
checks; the service-role key refused in the browser.

**Two React hazards this codebase has already been bitten by**, both with an
audit guarding them:

- A bare text node beside a conditionally-rendered element crashes with
  `NotFoundError` when a browser extension rewrites the text. Wrap text in a
  `<span>`. `npm run audit:reconciliation` enforces it.
- A keymap chord must be a string `chordFromEvent` can actually produce —
  `mod+\`, not `mod+backslash`. `src/stores/keymap.test.ts` enforces it.

**UI changes**: read `.claude/skills/ta-code-design/SKILL.md` first. It holds the
tokens, the surface hierarchy, and the desktop-vs-touch interaction model.

**Tests are evidence.** Do not weaken a test to make it pass, and check a new
test fails without its fix.
