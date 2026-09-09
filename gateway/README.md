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
| `TACODE_GVISOR` | off | `1` to run containers under `runsc` where it is installed. |

Nothing here is optional in the security sense: with no `SUPABASE_URL` the
process refuses to start, because a gateway that cannot authenticate anybody is
worse than one that is down.

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
npm test
```

138 tests. The terminal, protocol, session, sync, port-proxy and lifecycle
suites run for real — real HTTP, real WebSockets, real PTYs running real
`bash`, real files in a temporary directory — using the `local` runtime.

What they do **not** cover is container isolation, because a machine without a
Docker daemon cannot demonstrate it. `test/isolation.test.ts` asserts the
arguments that produce it, which catches the realistic failure (somebody adding
`--privileged` while debugging) but is not a substitute for running a container
and trying to escape it. Do that before this serves untrusted users.
