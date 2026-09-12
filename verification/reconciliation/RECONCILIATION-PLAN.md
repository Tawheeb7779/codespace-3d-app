# TA CODE — reconciliation plan

Read-only analysis. Nothing was merged, copied, moved, reset or pushed. Both
repositories are untouched and clean. The only write this analysis performed is
this file.

Trees compared:

| | `/home/user/codespace-3d-app` | `/home/user/phase1` |
|---|---|---|
| branch | `claude/forge-ide-build-ik8j7k` | `master` |
| HEAD | `29bb4a9` | `f201b27` |
| remote | `github.com/Tawheeb7779/codespace-3d-app` | **none** |
| commits | 79, root `fab0545` (2026-08-18) | 13, root `ac40dad` (2026-09-11) |
| tracked files | 420 | 418 |
| shared commits | **0** | **0** |

Referred to below as **FEATURE** and **PHASE1**.

---

## 0. The finding that governs everything else

PHASE1 is **not** a fork of FEATURE, and FEATURE is **not** a descendant of
PHASE1. They are two independent descendants of an older common TA CODE, and
the zip that produced PHASE1 carried its own changes that FEATURE never
received.

The proof is per-file. Comparing PHASE1's own baseline `ac40dad` against
FEATURE's HEAD:

| result | count | meaning |
|---|---|---|
| byte-identical | 9 of 19 | FEATURE never diverged there — PHASE1's change applies cleanly |
| divergent | 10 of 19 | both lines changed the same file — three-way work |

So PHASE1 holds **two distinct bodies of work**, and they must not be treated
alike:

- **(a) the validated phase work** — 41 files changed, +5056/−55, across
  `ac40dad..f201b27`. This is Phase 1/2/3, Core Completion and the Final Audit.
- **(b) zip-line-only content in PHASE1's baseline** — 16 files that exist at
  `ac40dad` and have no counterpart in FEATURE at all. This was never audited
  by the phase work and includes both a real security hardening and a duplicate
  of a FEATURE subsystem.

Everything below distinguishes (a) from (b).

---

## 1. Canonical repository recommendation

**`/home/user/codespace-3d-app`, branch `claude/forge-ide-build-ik8j7k`.**

PHASE1's content is ported **into** it. The reverse direction is rejected.

## 2. Why

1. **It is the real repository.** It has the GitHub remote. PHASE1 has no
   remote at all — it is a working copy of an uploaded archive with 13 commits
   of local history.
2. **It is a structural superset.** Every `src/lib` directory, every store,
   every route and every `components/ide` file that PHASE1 has, FEATURE also
   has — plus 11 more lib directories, 9 more stores and 12 more panels.
   Making PHASE1 canonical would mean porting ~35 subsystems; making FEATURE
   canonical means porting 41 files.
3. **History.** 79 commits with the product's whole lineage, versus a zip
   snapshot plus 13.
4. **Direction of divergence.** 9 of the 19 contested files are untouched in
   FEATURE since PHASE1's baseline, so more than half of the phase work lands
   as a clean application rather than a merge.

This is a recommendation about the *base*, not about *content*. PHASE1 holds
material FEATURE genuinely lacks, including two security boundaries. Section 9
treats those as blocking.

---

## 3. Feature inventory

### 3.1 Subsystems present in both, architecturally compatible

Same file paths, same roles, differing only where §4 records it.

| Subsystem | Notes |
|---|---|
| authentication | `authStore`, `AuthPage`, `supabase.ts` — identical |
| project management | `projectStore` — FEATURE identical to PHASE1 baseline; PHASE1 adds lifecycle cleanup |
| filesystem | `vfs.ts`, `fileStore` — both diverged, §4 |
| editor | `CodeEditor`, `editorStore`, `monaco.ts`, `modelSync` — identical |
| terminal | `TerminalView`, `terminalStore`, `ContainerTerminal` — diverged, §4 |
| run/tasks | `tasks.ts`, `taskStore`, `TasksPanel` — identical |
| preview | `preview/`, `previewStore`, `PreviewPanel` — identical |
| AI | diverged substantially, §4 and §5 |
| GitHub | `lib/github/`, `githubStore` — identical |
| workspaces | `workspaceStore`, `workspaceGitStore` — identical |
| collaboration | `lib/collab/`, `presenceStore`, `memberStore` — identical |
| Supabase | `supabase.ts`, `supabase/` migrations — identical |
| settings | `settingsStore`, `SettingsPage` — identical |
| mobile/tablet | `useIsMobile`/`useIsTouch`, mobile pane model — identical |
| source control | `vcs.ts`, `gitStore`, `GitPanel`, `lib/repo/` — identical |
| comments/mentions | `commentStore`, `CommentsPanel` — identical |
| voice | `lib/voice/`, `voiceStore`, `VoiceControl` — identical |
| shared editing (CRDT) | `lib/collab/` — identical |
| security centre | `lib/security/`, `SecurityPanel` — identical |
| agent | diverged substantially, §4 and §5 |

The named FEATURE commits `9c8ad51` (voice), `a77c128` (CRDT), `6a78e91`
(comments) and `f34f8f0` (security centre) landed **before** the zip snapshot
that produced PHASE1. Their content is in both trees. They are not at risk and
need no integration.

### 3.2 Subsystems only in FEATURE — all production, all preserved by default

Canonical is FEATURE, so these need no action; they are listed so their
preservation is explicit.

| Subsystem | Files | Commit |
|---|---|---|
| API studio | `lib/api/`, `apiStore`, `ApiPanel` | `dfa2ef5` |
| database studio | `lib/db/`, `dbStore`, `DatabasePanel` | `86ede10` |
| AI project builder | `ai/builder.ts`, `BuilderPanel` | `86ede10` |
| observability | `lib/observability/`, `ObservabilityPanel` | `cc3961a` |
| health dashboard | `lib/health/`, `checkStore`, `HealthPanel` | `8748576` |
| profiler / performance | `lib/perf/`, `perfStore`, `PerformancePanel` | `5571ab0` |
| architecture designer | `lib/architecture/`, `ArchitecturePanel` | `5571ab0` |
| environment manager | `lib/env/`, `envStore`, `EnvironmentPanel` | `4f36a86` |
| secrets vault | same commit, within `lib/env/` | `4f36a86` |
| timeline / time-travel | `lib/timetravel/`, `timeTravelStore`, `TimeTravelPanel` | `065b20c` |
| extensions | `lib/extensions/`, `extensionStore`, `ExtensionsPanel` | `065b20c` |
| UI builder | `lib/uibuilder/`, `uiBuilderStore`, `UIBuilderPanel` | `f020d1d` |
| agent drives the IDE | `ai/ideActions.ts`, `ai/ideTools.ts` | `17157cf` |
| Linux uploads | `lib/linux/uploads.ts`, `linuxFilesStore`, `LinuxFilesPanel` | `17157cf` |
| problem→fix bridge | `ai/fixPrompt.ts` + `BottomPanel` rows | `29bb4a9` |
| responsive preview lab | `e2e/preview-matrix.mjs` and preview work | `5cdffa2` |

Note the commit ids in the request `5cdffa3` and `065b20a` do not exist; the
real ones are `5cdffa2` and `065b20c`.

### 3.3 Content only in PHASE1

**(a) validated phase work — 22 new files, 19 modified:**

| Area | Files |
|---|---|
| AI intelligence | `ai/intelligence.ts` + 2 test files |
| privacy / redaction | `ai/privacy.ts` + test |
| validation architecture | `ai/validation.ts` + test, `enforcement.test.ts`, `agentValidationWiring.test.ts` |
| plan model | `ai/plan.ts` + test |
| connection four states | `ai/connection.ts` + test |
| read integrity | `readIntegrity.test.ts`, `repairFlow.test.ts`, changes in `ai/context.ts` and `ai/tools.ts` |
| provider wire/security | `providerWire.test.ts`, `providerSecurity.test.ts`, changes in `ai/provider.ts` |
| Phase 2 tree caching | `lib/treeSignature.test.ts`, `vfs.ts`, `FileExplorer.tsx` |
| terminal batching | `terminal/outputBatcher.ts` + test, `ContainerTerminal.tsx` |
| sync settling | `terminal/syncSettle.test.ts`, `terminal/workspaceSync.ts` |
| project lifecycle | `stores/projectLifecycle.test.ts`, `projectStore.ts` |
| Final Audit fixes | `BottomPanel.tsx` (P0), `agentStore.ts` (P1), `ai/connection.ts` (P2), `e2e/agent-provider.mjs` |
| verification | 12 files under `verification/` |

**(b) zip-line-only baseline content — 16 files, never in FEATURE:**

| File | What it is | Verdict |
|---|---|---|
| `gateway/src/secureFs.ts` (+ test) | O_NOFOLLOW descriptor-relative I/O via `/proc/self/fd`; defeats symlink-swap TOCTOU from inside a container | **security boundary — integrate** |
| `gateway/src/files.ts` (+ test) | `workspaceFile` operation secureFs serves | **integrate with secureFs** |
| gateway `ownedWorkspace()` in `server.ts` | role ≥ editor authorization before sync/transfer | **authorization boundary — integrate** |
| protocol v5 `workspace-file` frames | `src/lib/terminal/protocol.ts` | **integrate with the two above** |
| `src/lib/terminal/importLinux.ts`, `components/ide/LinuxFiles.tsx` (+ tests) | 166 lines of Linux file UI | **do not integrate — duplicate, §8** |
| `docker/workspace/bashrc` | container shell profile | integrate if the Dockerfile references it |
| `VERIFICATION-REPORT.md`, `verification/*.json` | earlier-session artifacts | optional |
| `src/lib/ai/navigation.test.ts`, `src/lib/idbCommit.test.ts`, `src/lib/terminal/workspaceSync.test.ts` | tests for code FEATURE has | integrate — free coverage |

---

## 4. Files requiring manual reconciliation

Ten files where **both lines changed the same file**. The first number is
FEATURE's divergence from PHASE1's baseline; the second is the size of the
phase-work change. Highest risk first.

| # | File | FEATURE Δ | PHASE1 Δ | Why each side changed | Method |
|---|---|---|---|---|---|
| 1 | `src/lib/ai/tools.ts` | 158 | 351 | FEATURE added IDE-driving tools (`17157cf`) and terminal independence (`022bfe7`); PHASE1 added three comprehension tools, argument validation, read integrity, plan enforcement | **combine both.** Tool sets are additive; the `ToolContext`/`runTool` shape is shared. Take PHASE1's context fields and guards, re-register FEATURE's tools on top |
| 2 | `src/components/ide/BottomPanel.tsx` | 78 | 134 | FEATURE added the problem→fix action (`29bb4a9`) and terminal-environment split (`022bfe7`); PHASE1 narrowed the terminal-session subscription | **combine.** Keep FEATURE's file; apply only the P0 signature-string selector. FEATURE still calls bare `useTerminalStore()` — the narrowing is a real improvement, but port **only the fixed form**, never the `useShallow` intermediate |
| 3 | `src/stores/aiStore.ts` | 73 | 147 | FEATURE wired health (`8748576`) and IDE actions (`17157cf`); PHASE1 wired validation, plan enforcement and connection state | **combine.** Both are additive wiring on one store |
| 4 | `src/components/ide/ContainerTerminal.tsx` | 84 | 112 | FEATURE split the two terminal environments; PHASE1 added output batching with disposal on three teardown paths | **combine.** Batching is orthogonal; ensure `dispose()` covers FEATURE's teardown paths too |
| 5 | `src/lib/terminal/workspaceSync.ts` | 34 | 122 | zip-line sync divergence; PHASE1 added settle-awareness | **combine.** Depends on the protocol decision in §7 |
| 6 | `src/stores/fileStore.ts` | 38 | 57 | FEATURE: project-history isolation (`b85aab3`), verified saves (`30b4955`); PHASE1: `notifyAgent` on write/create/remove | **combine.** PHASE1's is 3 call sites; do not disturb `reportSaveFailure` or `assertWrote` |
| 7 | `src/stores/agentStore.ts` | 12 | 87 | FEATURE: time-travel recording (`065b20c`); PHASE1: validation state, and the P1 `noteChange` fix | **combine.** See §5 — P1 is meaningless without the read-integrity work in `context.ts` |
| 8 | `src/lib/ai/agent.ts` | 12 | 33 | FEATURE: IDE tools in the turn; PHASE1: read-only turns, permission recheck, repair limits | **combine** |
| 9 | `src/components/ide/FileExplorer.tsx` | 16 | 28 | FEATURE: mobile surface (`914f5e7`); PHASE1: `buildTreeCached` memo | **combine.** PHASE1's is a one-line `useMemo` |
| 10 | `src/lib/vfs.ts` | 1 | 54 | FEATURE lacks the zip line's `.ta-code` ignore pattern; PHASE1 added `treeSignature`/`buildTreeCached`/`resetTreeCache` | **combine.** Keep `normalizePath` byte-identical — it is the single path choke point |

### Infrastructure conflicts, decided rather than merged

| File | FEATURE | PHASE1 | Decision |
|---|---|---|---|
| `package.json` | `vitest ^3.2.7`, `@vitest/coverage-v8 ^3.2.7` | `vitest 4.1.11` pinned, `vite-node 3.2.4` | **Keep FEATURE's vitest 3 for the port.** A major test-runner upgrade during a reconciliation makes every failure ambiguous. Upgrade as a separate, later change |
| `gateway/package.json` | `node dist/index.js`, `tsc -p` | `node --import tsx src/index.ts`, `tsc --noEmit` | **Keep FEATURE's built-dist model.** PHASE1's runs TypeScript in production |
| `package-lock.json`, `gateway/package-lock.json` | — | — | **Never hand-merge.** Regenerate with `npm install` after `package.json` is settled |
| `src/types/index.ts` | identical to PHASE1 baseline | adds `'agent.unverified'` | **Take PHASE1's** — one line, clean |
| `src/lib/terminal/protocol.ts` | v4 | v5 + `workspace-file` frames | §7 — both sides together or not at all |
| `gateway/src/{sync,server,transfer,ports,syncService}.ts`, `runtime/*` | — | 65/41/31/38/12/8/5 lines | zip-line divergence, not phase work. Port **only** `ownedWorkspace` and the `workspace-file` handler; leave the rest |
| `gateway/test/hardeningAudit.test.ts` | — | 11 lines | take PHASE1's if the gateway auth changes land |
| `public/preview-runtime/*.js` | — | — | generated. Rebuild with `npm run build:preview-runtime`; never merge |
| `e2e/artifacts/*.png` | 160 files | 1 file | failure screenshots. Ignore entirely |

## 5. Safe to take from PHASE1 as-is

**22 new files** from the phase work — nothing in FEATURE occupies these paths:

```
src/lib/ai/{intelligence,privacy,validation,plan,connection}.ts
src/lib/ai/{intelligence,privacy,validation,plan,connection}.test.ts
src/lib/ai/{intelligenceTools,enforcement,providerWire,providerSecurity,readIntegrity,repairFlow}.test.ts
src/lib/terminal/{outputBatcher.ts,outputBatcher.test.ts,syncSettle.test.ts}
src/lib/treeSignature.test.ts
src/stores/{agentValidationWiring,projectLifecycle}.test.ts
verification/**  (12 files)
```

**9 modified files where FEATURE is byte-identical to PHASE1's baseline** — the
phase-work version can be taken wholesale:

```
src/types/index.ts
src/stores/projectStore.ts
src/lib/ai/{task,provider,context}.ts
src/lib/activity.ts
src/components/ide/{AssistantPanel,AgentTaskBar}.tsx
e2e/agent-provider.mjs
```

Plus three free test files from the zip baseline: `src/lib/ai/navigation.test.ts`,
`src/lib/idbCommit.test.ts`, `src/lib/terminal/workspaceSync.test.ts`.

### Where each mandated item stands in FEATURE

| Validated PHASE1 work | Equivalent in FEATURE? | Consequence |
|---|---|---|
| AI intelligence / privacy / validation / plan | **none** — files absent | port whole |
| connection four-state model | **none** — `connection.ts` absent | port whole |
| Phase 2 tree caching | **none** — no `buildTreeCached`/`treeSignature` | port |
| terminal output batching | **none** — no `OutputBatcher` | port |
| agent validation wiring | **none** — no `notifyAgent`/`noteExternalEdit` in `fileStore` | port |
| project lifecycle cleanup | **none** — no `forgetSession` in `projectStore` | port |
| sync settling | **none** | port |
| Linux import/files | **superseded** — FEATURE's `lib/linux/uploads.ts` + panel is 691 lines vs 166 | do not port, §8 |
| **P0** BottomPanel | **bug absent** — FEATURE never had the `useShallow` selector | port the fixed selector only |
| **P1** agent repair loop | **bug absent** — `hasCurrentRead` does not exist in FEATURE's `context.ts`/`tools.ts` | port `noteChange` **only together with** the read-integrity work; alone it is meaningless |
| **P2** connection copy | n/a — `connection.ts` absent | arrives with the file |
| regression tests | absent | port all |
| verification artifacts | absent | port all |

**No item is superseded by a better FEATURE implementation except the Linux
file UI.**

## 6. Safe to take from FEATURE

Everything not named in §4 or §5 — the whole of §3.2, plus every file the two
trees already agree on. Explicitly: all 12 extra panels, all 9 extra stores, all
11 extra `src/lib` directories, `ai/builder.ts`, `ai/fixPrompt.ts`,
`ai/ideActions.ts`, `ai/ideTools.ts`, and all `supabase/` migrations —
**untouched, per the standing instruction**.

## 7. Features requiring manual integration

1. **Gateway authorization (`ownedWorkspace`)** — highest priority. FEATURE
   calls `containers.byId(frame.containerId, connection.userId!)` with no role
   check on sync, transfer and port frames. PHASE1 wraps those in a check for
   role ≥ editor on the owning project, and additionally requires
   `session.containerId === connection.session?.containerId`. **FEATURE is the
   weaker line here.** Integrate with its gateway tests.
2. **`secureFs.ts` + `files.ts` + protocol v5** — one unit. Do not raise
   `PROTOCOL_VERSION` unless both the client frames and the gateway handler land
   in the same change; a version bump on one side alone breaks every connection.
3. **Read integrity + P1** — `context.ts` `ReadCache.hasCurrentRead`, the
   `tools.ts` write guard, and `agentStore.noteChange` are one mechanism.
   Porting any one alone either does nothing or refuses legitimate writes.
4. **Phase 2 batching + FEATURE's terminal split** — the batcher must be
   disposed on every teardown path FEATURE has, not only the three PHASE1 had.
5. **`ai/tools.ts`** — the only file where both sides made large, independent
   additions. Expect to do this one by hand, tool by tool.

## 8. Features that must NOT be integrated

| Item | Reason |
|---|---|
| `src/lib/terminal/importLinux.ts`, `components/ide/LinuxFiles.tsx` + their tests | Duplicate of FEATURE's `lib/linux/uploads.ts` + `linuxFilesStore` + `LinuxFilesPanel`, which is larger, newer, has its own tests, and states its binary-file limit honestly. Two Linux file UIs would be a contradictory implementation |
| `vitest 4.1.11` / `vite-node` | Major upgrade mid-reconciliation. Separate change |
| PHASE1's `gateway/package.json` run model | Runs TypeScript via `tsx` in production |
| PHASE1's `gateway/src/{sync,transfer,ports,syncService}.ts` and `runtime/*` wholesale | Zip-line divergence, never audited by the phase work. Cherry-pick only what §7 items 1–2 require |
| Either `package-lock.json` | Regenerate |
| `public/preview-runtime/*.js` | Generated |
| `e2e/artifacts/*.png` | Failure screenshots from past runs |
| PHASE1's `README.md` / `gateway/README.md` wholesale | Describe the zip line. Merge prose by hand |
| Any `supabase/migrations/` change | Standing instruction: never touched |

## 9. Security risks

**Boundaries present only in PHASE1 — porting is a security improvement:**

1. **Gateway workspace authorization.** §7 item 1. Until ported, FEATURE
   authorizes container-scoped sync and transfer frames by container ownership
   alone, without the project role check PHASE1 performs.
2. **`secureFs.ts`.** Descriptor-relative I/O with `O_NOFOLLOW`, resolving
   through `/proc/self/fd`, so a container that replaces a path with a symlink
   between check and use cannot redirect the write. Absent from FEATURE.
3. **`privacy.ts`.** Credential redaction before any prompt leaves the browser.
   Absent from FEATURE.
4. **Read integrity.** The whole-file-write rule — never overwrite content
   nobody has read. Absent from FEATURE.

**Risks created by the reconciliation itself:**

- `normalizePath` must remain byte-identical and remain the only path choke
  point. It is inside `vfs.ts`, a file §4 requires editing.
- `gateway/src/workspace.ts` is already identical in both trees (0 diff) —
  it must stay that way; `secureFs.ts` imports its `normalizePath`/`PathError`.
- `run audit:secrets` must pass over the built output after every step; the
  server-side-only GitHub token rule and the `VITE_*` prohibition are unchanged.
- Preview sandbox without `allow-same-origin`, `postMessage` source
  verification and `noopener` are identical in both trees and must not be
  touched by any step here.
- No test may be weakened, skipped or deleted to make a port pass.

## 10. Regression risks

| Risk | Where | Mitigation |
|---|---|---|
| React #185 infinite render | `BottomPanel.tsx` | never introduce a selector returning fresh objects; the P0 fix's signature string is the pattern. Run `e2e/workspace.mjs` — the bug showed as 7/18 steps |
| Agent cannot repair its own file | `agentStore`/`context`/`tools` | port as one unit; `repairFlow.test.ts` is the guard |
| Terminal output loss or leak | `ContainerTerminal.tsx` | batcher disposed on **every** FEATURE teardown path |
| Protocol mismatch, all sessions fail | `protocol.ts` + gateway | both sides in one commit, or neither |
| Lockfile drift, unbuildable tree | lockfiles | regenerate, never merge |
| Tool-registry collision | `ai/tools.ts` | check for duplicate tool names after combining both sets |
| Double Linux UI | `LinuxFilesPanel` vs `LinuxFiles` | §8 — do not port |
| Save silently failing | `fileStore.ts` | `assertWrote` and `reportSaveFailure` untouched |
| Text-node crash | any JSX edit | `npm run audit:reconciliation` |
| Contrast / hue regression | any token edit | `npm run audit:contrast` |

## 11. Test strategy after reconciliation

Baselines to beat, both observed:

| | FEATURE `29bb4a9` | PHASE1 `f201b27` |
|---|---|---|
| frontend test files | 101 | 107 |
| gateway test files | 20 | 22 |
| frontend tests | to be measured before starting | 1584 passed, 0 failed |
| gateway tests | to be measured before starting | 378 passed, 53 Docker-skipped |

1. **Before any port**, record FEATURE's own `npm run verify` result and its
   frontend/gateway test counts. Without that number nothing afterwards can be
   attributed.
2. `npm run verify` after **every** step in §12 — typecheck, lint,
   `audit:reconciliation`, `audit:contrast`, `audit:secrets`, tests, build.
3. Gateway: `npm run gateway:typecheck && npm run gateway:test`.
4. Targeted regression after the step that lands each unit:
   `repairFlow`, `readIntegrity`, `validation`, `enforcement`,
   `agentValidationWiring`, `projectLifecycle`, `outputBatcher`,
   `treeSignature`, `syncSettle`, `connection`, `privacy`, `intelligence`.
5. **Browser suites are the acceptance gate, not the unit tests.** All three
   Final Audit defects passed 1578 unit tests. Run all 13 against a built
   `dist` served by `npx vite preview`: smoke, workspace, product, devexp,
   collaboration, github, agent, preview-matrix, platform, persistence, polish,
   integration, stress. Target: **231 workflows, 0 failed**, console and page
   errors `(none)`. `e2e/agent.mjs` needs `npm run agent:test-provider` first;
   `e2e/github.mjs` needs `npm run github:test-api`.
6. A new test must be shown to fail without its fix.
7. Unchanged limitations: no Docker (53 gateway tests stay skipped), no live
   Supabase, no real GitHub API, no live AI provider. State them; do not claim
   them verified.

## 12. Recommended order of operations

Each step is one commit, each gated by §11.2.

| # | Step | Risk |
|---|---|---|
| 0 | Record FEATURE's baseline numbers. Tag `pre-reconciliation`. Mirror both repos to a backup path | — |
| 1 | Take the 22 new phase-work files + 3 free tests. Nothing imports them yet | very low |
| 2 | Take the 9 byte-identical modified files (`types/index.ts`, `projectStore.ts`, `task.ts`, `provider.ts`, `context.ts`, `activity.ts`, `AssistantPanel.tsx`, `AgentTaskBar.tsx`, `agent-provider.mjs`) | low |
| 3 | `vfs.ts` + `FileExplorer.tsx` — Phase 2 tree caching. Keep `normalizePath` identical | low |
| 4 | `ContainerTerminal.tsx` — output batching, disposal on every teardown path | medium |
| 5 | `fileStore.ts` — `notifyAgent` at 3 call sites | medium |
| 6 | `ai/tools.ts` — combine both tool sets and PHASE1's guards. **The hard one** | high |
| 7 | `ai/agent.ts` + `agentStore.ts` + `aiStore.ts` — validation wiring and the P1 fix, as one unit with step 6 | high |
| 8 | `BottomPanel.tsx` — P0 selector onto FEATURE's file | medium |
| 9 | `workspaceSync.ts` — settle-awareness | medium |
| 10 | Gateway authorization: `ownedWorkspace` + `hardeningAudit.test.ts` | high, security |
| 11 | `secureFs.ts` + `files.ts` + `server.ts` handler + protocol v5, **one commit** | high, security |
| 12 | Regenerate lockfiles and `public/preview-runtime/*` | low |
| 13 | Full `npm run verify` + all 13 browser suites + a new FINAL-AUDIT run | gate |
| 14 | Write `verification/reconciliation/RECONCILIATION-REPORT.md` with observed numbers | — |

Steps 10 and 11 may be done before step 1 if the authorization gap is judged
urgent; they are independent of the frontend work.

## 13. Backup and rollback

- Both repositories stay on disk, untouched, for the duration. `/home/user/phase1`
  is the only copy of `f201b27` — **it must not be deleted, reset or checked
  out to another branch.**
- Before step 1, mirror both: `git clone --mirror` to a backup path, and tag
  `pre-reconciliation` on FEATURE's current HEAD `29bb4a9`.
- One commit per step, so rollback is `git revert <step>` — never a reset on a
  branch already pushed.
- `29bb4a9` is already on the remote, so the branch's published history is
  itself a recovery point.
- No force-push, no history rewrite, at any step.

## 14. Expected final branch

`claude/forge-ide-build-ik8j7k` in `/home/user/codespace-3d-app`, on
`github.com/Tawheeb7779/codespace-3d-app`, with `29bb4a9` as an ancestor and
roughly 14 new commits on top. No new branch, no rebase, no force-push.
`/home/user/phase1` stays as it is, as the archival record of `f201b27`.

Push only when explicitly asked.

## 15. Expected final verification

The tree is reconciled only when all of the following are observed, not
inferred:

1. `npm run verify` passes — typecheck, lint, `audit:reconciliation`,
   `audit:contrast`, `audit:secrets`, unit tests, production build.
2. `npm run gateway:typecheck` and `npm run gateway:test` pass; skipped count
   is exactly the 53 Docker-only tests.
3. Frontend test count ≥ FEATURE's recorded baseline **plus** the phase work's
   new tests, with 0 failures.
4. All 13 browser suites run against a built `dist`: **231 workflows or more,
   0 failed**, console errors `(none)`, page errors `(none)`.
5. Every Final Audit regression test passes: `repairFlow`, `readIntegrity`,
   `validation`, `enforcement`, `agentValidationWiring`, `projectLifecycle`,
   `outputBatcher`, `treeSignature`, `syncSettle`, `connection`.
6. No security boundary weakened: `normalizePath` unchanged and still the only
   choke point; sandbox without `allow-same-origin`; `postMessage` source
   verification; `noopener`; no `VITE_*` secret; RLS and the service-role
   browser refusal unchanged; gateway authorization now **stronger** than at
   `29bb4a9`.
7. Exactly one implementation of every subsystem — specifically one Linux file
   UI, one tool registry, one connection model.
8. `supabase/migrations/` byte-identical to `29bb4a9`.
9. External limitations restated verbatim, not converted into success claims:
   no Docker, no live Supabase, no real GitHub API, no live AI provider, no
   physical device.

Until items 1–9 are observed on one tree, the two lines are **not** proven
safely merged.
