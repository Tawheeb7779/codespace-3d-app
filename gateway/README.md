# TA CODE container gateway

The service behind the **Linux Container** terminal: it authenticates a caller,
gives them one workspace container per project, carries a PTY over a WebSocket,
and proxies their development server. It is a separate process from the TA CODE
frontend, and deliberately so — it needs long-lived connections, a container
runtime and a writable disk, none of which a static host or an Edge Function
provides.

TA CODE works without it. With no gateway configured the terminal is the
virtual one that has always been there, and nothing in the product depends on
this service existing.

## Running it

```
npm install
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
TACODE_WORKSPACE_ROOT=/var/lib/ta-code/workspaces \
TACODE_ALLOWED_ORIGINS=https://your-ta-code-deployment \
npm run dev
```

Then point the frontend at it with `VITE_CONTAINER_GATEWAY_URL=wss://…`.

The container image is built separately and pinned:

```
docker build -t ta-code/workspace:1 ../docker/workspace
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | |
| `SUPABASE_URL` | — | Required. Identity is verified against this project and no other. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Required. Never leaves this process's outbound headers. |
| `TACODE_RUNTIME` | `docker` | `local` runs shells as child processes with **no isolation**; refused when `NODE_ENV=production`. |
| `TACODE_IMAGE` | `ta-code/workspace:1` | Pin by digest in production. |
| `TACODE_WORKSPACE_ROOT` | `/var/lib/ta-code/workspaces` | One directory per container. |
| `TACODE_ALLOWED_ORIGINS` | *(any)* | Comma-separated. A WebSocket is not subject to the same-origin policy, so set this. |
| `TACODE_NETWORK` | `none` | `full` gives containers outbound access, which `npm install` needs. |
| `TACODE_ALLOWED_PORTS` | `3000,4000,5000,5173,8000,8080,8081` | Ports the proxy will reach. |
| `TACODE_MAX_CONTAINERS` | `50` | Host ceiling. |
| `TACODE_MAX_CONTAINERS_PER_USER` | `2` | |
| `TACODE_DEFAULT_TIER` | `free` | |
| `TACODE_FREE_*` / `TACODE_PRO_*` | see `src/config.ts` | `CPUS`, `MEMORY_MB`, `DISK_MB`, `PIDS`, `IDLE_SECONDS`, `MAX_LIFETIME_SECONDS`, `MAX_SESSIONS`. |
| `TACODE_GVISOR` | off | `1` to run containers under `runsc` where it is installed. Untested — see below. |
| `TACODE_MAX_CONNECTIONS` | `500` | Sockets this process will hold. Refused before the WebSocket is accepted. |
| `TACODE_MAX_CONNECTIONS_PER_USER` | `8` | |
| `TACODE_MAX_SYNC_BYTES_PER_SECOND` | `8388608` | File bytes one connection may push per second. |
| `TACODE_RUNTIME_TIMEOUT_MS` | `30000` | How long a `docker` command may take before it is abandoned. |

Nothing here is optional in the security sense: with no `SUPABASE_URL` the
process refuses to start, because a gateway that cannot authenticate anybody is
worse than one that is down.

## Two terminals, and the boundary between them

TA CODE has two terminal concepts and they are not the same feature.

The **Project Terminal** is the in-browser shell that has always been here. It
is project-scoped, runs against the project's virtual filesystem, needs no
server, and is the default — the environment selector only appears where a
container gateway is configured, so a deployment without one has exactly the
terminal it always had. Nothing in this gateway replaces it, and a container
being unavailable degrades to it rather than to an error.

The **Linux Terminal** is this gateway: a real shell in a real container. Today
it is scoped to one project, and that scoping is the security boundary rather
than a convenience:

- One container per `(user, project)`, keyed by a SHA-256 of that pair.
- Exactly one bind mount, that project's workspace, and no other host path. A
  test asserts the count, not just the contents.
- Every connection re-authorises against that project, and an open terminal is
  re-checked on a timer so revoked access does not survive in a live shell.

A user's *other* projects are not reachable from inside a container, and neither
is anything else of theirs. That property comes from the single mount, so it
holds regardless of what the workload does.

**What is deliberately not built yet.** The eventual design is a Linux Workspace
that exists independently of any project, with explicit authorised import and
export between it and a project. That is a separate phase. Until it exists, the
container is reached through the project terminal's environment selector, and
the thing to preserve when it is built is the mount rule above: a workspace that
could see every project the user owns would turn one compromised dependency into
access to all of their work.

## Workspace migration

The container id changed from a 32-bit FNV-1a to a 128-bit SHA-256, because the
old one could be collided deliberately: project ids are chosen in the browser,
so an attacker ground out a project id whose key hashed to a victim's and their
container mounted the victim's workspace. The id names the workspace directory,
so fixing it renamed every future workspace and stranded every existing one.

**Stranded workspaces are never migrated automatically, and that is deliberate.**
Migration needs to know who owns a directory, and nothing can say:

- the name is a one-way hash, so `tacode-10847e1b` cannot be reversed;
- `container_workspaces` would be the record tying an id to a user, and the
  gateway has never written a row to it — the table exists and is empty;
- the old hash collided by construction, so a directory does not necessarily
  correspond to one `(user, project)` pair at all.

Migrating on a guess would hand one user a directory that may be another's,
which is the exposure the id change closed. So the gateway detects and reports,
and a person migrates one project at a time.

```
# What is stranded. Also logged at boot.
npm run migrate:workspaces -- --list

# Migrate one, having established who it belongs to.
npm run migrate:workspaces -- --user <uuid> --project <id> --dry-run
npm run migrate:workspaces -- --user <uuid> --project <id>
```

The dry run prints both ids; check the legacy one against the directory before
running for real. Nothing is ever deleted, the move is a `rename` so there is no
window where the files are in neither place, and re-running is a no-op. It
refuses if a non-empty workspace already exists under the new id, because that
would merge two projects' files.

A workspace nobody migrates is not lost — it is simply not found by any user,
and stays on disk until an operator removes it.

## What is enforced, and where

Application code enforces *authorisation*: who you are, which project you may
open a shell in, whose session you may attach to, which port you may reach. The
container runtime enforces *resources*: CPU, memory, disk, process count. That
split matters — a fork bomb does not read an application limit, and a pids
cgroup does not know who you are.

The container's own restrictions live in one function, `createArgs` in
`src/runtime/docker.ts`, and are tested as data in `test/isolation.test.ts`:
non-root, no capabilities, no new privileges, read-only image, `noexec` tmpfs,
one bind mount, no Docker socket, no host namespaces, network off by default.

## Testing

```
npm test                                              # everything but isolation
TACODE_DOCKER_TESTS=1 npx vitest run test/dockerSecurity.test.ts
```

The terminal, protocol, session, sync, port-proxy, hardening and lifecycle
suites run for real — real HTTP, real WebSockets, real PTYs running real
`bash`, real files in a temporary directory — using the `local` runtime.
`test/syncEndToEnd.test.ts` drives the browser's own client against the gateway
over a real socket, which is where a protocol drifts: each side otherwise
passes its own tests while disagreeing about the wire.

### Isolation, and what has actually been demonstrated

Two suites, and they are not redundant.

`test/isolation.test.ts` reads the arguments `createArgs` produces. It runs
anywhere and catches the realistic regression — somebody adding `--privileged`
while debugging on a Friday.

`test/dockerSecurity.test.ts` creates a real container on a real daemon and
tries to get out of it: twenty-six checks over identity, capabilities,
namespaces, mounts, filesystem, secrets, cgroup limits, network and port
discovery. It is gated behind `TACODE_DOCKER_TESTS=1` and skips loudly rather
than passing vacuously, because a security suite that reports success on a
machine with no daemon is worse than none — somebody reads the green tick.

Reading arguments cannot tell you a flag does what its name says, and running
them proved it twice. `--storage-opt size=` makes the daemon refuse to create
the container at all on any filesystem but XFS with `pquota`; it is now probed
once at startup and omitted where it cannot be enforced. And the workspace bind
mount was created as root while the container runs as uid 10001, so every
container was handed a project directory it could not write to. Every flag was
correct in both cases.

**Status of each claim**, so nothing here is taken on trust:

| Claim | Status |
|---|---|
| Non-root, no capabilities, no new privileges | Verified on a real daemon (sec01–sec04) |
| Read-only image, `noexec` tmpfs, workspace writable | Verified (sec09–sec11) |
| No Docker socket, no host namespaces, one bind mount | Verified (sec12–sec16) |
| No gateway secrets reachable from inside | Verified (sec17, sec18) |
| pids, memory and CPU limits enforced by the kernel | Verified, read from the container's own cgroup (sec19–sec21) |
| `--network none` leaves nothing reachable | Verified, including cloud metadata (sec22, sec23) |
| Port discovery is namespaced to the container | Verified (sec24, sec25) |
| Seccomp filter loaded in the container | Verified — `Seccomp: 2` read from the container's own `/proc/self/status` (sec27) |
| gVisor (`--runtime runsc`) | **Unverified.** Implemented and gated; `runsc` is not installed on any host this has run on, and `docker info` reports only `runc`. It raises the cost of a kernel exploit and is not an escape guarantee — do not describe it as one. |
| AppArmor / SELinux confinement | **Not available on the hosts tested.** `docker info` reports `SecurityOptions: [name=seccomp,profile=builtin]` and `AppArmorProfile` is empty, so seccomp is the only kernel-level syscall filter in play. A host with AppArmor would add one; nothing here depends on it. |
| Behaviour under production-like load | **Unverified.** The limits are tested by reaching them on one host; they have not been observed under real concurrent use. |

`docker/workspace/build-offline-rootfs.sh` builds a stand-in image from host
binaries for a machine that has a daemon but cannot reach a registry, so
isolation can be executed there rather than skipped. It is not the production
image and must never be shipped: the properties under test belong to the
container, not to the image inside it, which is what makes the substitution
sound for this purpose and unsound for any other.
