#!/usr/bin/env bash
#
# Build a minimal workspace image from the host, for environments with no
# registry access.
#
# The real image is `docker/workspace/Dockerfile`, built `FROM ubuntu:24.04`.
# This is its stand-in for one specific situation: a machine that has a working
# Docker daemon but cannot reach a registry — which is exactly the machine this
# repository's security suite was first run on, and would otherwise be a machine
# where container isolation stays untested.
#
# It assembles a rootfs by copying a named set of binaries out of the host along
# with the libraries `ldd` says they need. The result is a few tens of megabytes
# and contains a real shell, real coreutils and the handful of tools the
# security tests use to probe their own confinement.
#
# What it is NOT: the production image. It has no Node and no Python, and its
# provenance is "whatever this host had". It does carry a real git, because
# Phase 2's git service is only meaningfully tested against a real repository. Never ship it. The security
# properties under test — user, capabilities, namespaces, cgroup limits,
# read-only root, mounts, network — are properties of the *container*, not of
# the image inside it, which is what makes this substitution sound for that
# purpose and unsound for any other.
#
#   ./build-offline-rootfs.sh ta-code/workspace-test:1

set -euo pipefail

IMAGE="${1:-ta-code/workspace-test:1}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# Everything the security suite needs to interrogate its own confinement, plus
# a shell to run it from.
BINARIES=(
  bash sh env
  id whoami getent
  ls cat echo touch mkdir rm cp mv ln readlink realpath stat df du
  grep sed awk sort head tail tr cut wc find xargs
  sleep timeout true false test
  mount umount
  ps kill
  dd chmod chown
  hostname uname nproc
  tar gzip
  capsh setpriv
  ip
  # A listener, so port discovery can be tested against a container that is
  # genuinely serving something rather than against a fixture of what one
  # would look like.
  nc
  # Real git, so Phase 2's git service can be tested against a real repository
  # in a real container rather than against a fake of one.
  git
)

mkdir -p "$ROOT"/{usr/bin,usr/sbin,usr/lib,usr/lib64,etc,tmp,proc,sys,dev,workspace,home/dev,var/tmp}

# The usr-merge layout every current distribution uses: /bin, /sbin, /lib and
# /lib64 are symlinks into /usr. Without them `/bin/bash` does not exist, which
# is how the first run of the security suite failed sixteen tests for one
# reason that had nothing to do with security.
ln -sfn usr/bin "$ROOT/bin"
ln -sfn usr/sbin "$ROOT/sbin"
ln -sfn usr/lib "$ROOT/lib"
ln -sfn usr/lib64 "$ROOT/lib64"

copy_with_libs() {
  local binary="$1"
  local resolved
  resolved="$(command -v "$binary" 2>/dev/null || true)"
  # Shell builtins resolve to a bare word rather than a path — `echo` and
  # `test` are both builtins and files, and only the file can be copied.
  case "$resolved" in /*) ;; *) return 0 ;; esac

  install -D "$resolved" "$ROOT${resolved}"

  # Shared objects, as the loader would resolve them. A binary copied without
  # its libraries is a binary that fails with a message about the loader, which
  # looks exactly like a sandbox denial and would make every test ambiguous.
  ldd "$resolved" 2>/dev/null | while read -r line || [ -n "$line" ]; do
    local lib
    lib="$(printf '%s' "$line" | grep -oE '/[^ ]+\.so[^ ]*' | head -1 || true)"
    [ -n "$lib" ] && [ -e "$lib" ] || continue
    [ -e "$ROOT$lib" ] || install -D "$lib" "$ROOT$lib"
  done
}

for binary in "${BINARIES[@]}"; do copy_with_libs "$binary"; done

# Git is not one binary. `git` dispatches to helpers in its exec path, and a
# rootfs with only `/usr/bin/git` reports "is not a git command" for everything
# — which looks exactly like a broken git service and is a missing directory.
GIT_CORE="$(git --exec-path 2>/dev/null || echo /usr/lib/git-core)"
if [ -d "$GIT_CORE" ]; then
  mkdir -p "$ROOT$GIT_CORE"
  # The helpers that are real programs rather than hardlinks to `git` itself.
  # Copying the whole directory is ~11MB and keeps `git` self-consistent, which
  # matters more here than image size: this image exists to test behaviour.
  cp -a "$GIT_CORE/." "$ROOT$GIT_CORE/"
  for helper in "$GIT_CORE"/*; do
    [ -f "$helper" ] || continue
    # `|| continue` rather than an `&&` chain: under `set -e`, a chain whose
    # last test is false makes the loop's exit status non-zero and kills the
    # script — which is how this silently produced an image with no git.
    # `|| true` on the whole pipeline. Several git helpers are shell scripts,
    # `ldd` exits non-zero on those, and under `set -e` that killed the build —
    # silently producing an image with no git at all.
    ldd "$helper" 2>/dev/null | grep -oE '/[^ ]+\.so[^ ]*' | while read -r lib; do
      [ -n "$lib" ] && [ -e "$lib" ] || continue
      [ -e "$ROOT$lib" ] || install -D "$lib" "$ROOT$lib"
    done || true
  done
fi

# Git templates, so `git init` produces a repository rather than complaining.
for share in /usr/share/git-core; do
  [ -d "$share" ] || continue
  mkdir -p "$ROOT$share"
  cp -a "$share/." "$ROOT$share/"
done

# The dynamic loader itself, which `ldd` names but does not always list. It is
# installed under its real path so the symlinks above resolve to it.
for loader in /usr/lib64/ld-linux-x86-64.so.2 /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2; do
  [ -e "$loader" ] || continue
  [ -e "$ROOT$loader" ] || install -D "$loader" "$ROOT$loader"
done
# Some hosts only have it at the pre-merge path; follow it to its real file.
for loader in /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-x86-64.so.2; do
  [ -e "$loader" ] || continue
  real="$(readlink -f "$loader")"
  target="$ROOT/usr/lib64/ld-linux-x86-64.so.2"
  [ -e "$target" ] || install -D "$real" "$target"
done

# A passwd/group pair, so `id` resolves the unprivileged user by name rather
# than printing a bare uid — the tests assert on the identity, and a numeric
# answer would be a weaker assertion.
cat > "$ROOT/etc/passwd" <<'PASSWD'
root:x:0:0:root:/root:/bin/bash
dev:x:10001:10001:workspace:/home/dev:/bin/bash
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
PASSWD

cat > "$ROOT/etc/group" <<'GROUP'
root:x:0:
dev:x:10001:
nogroup:x:65534:
GROUP

echo 'workspace' > "$ROOT/etc/hostname"
printf 'root:x:0:0:root:/root:/bin/bash\n' > /dev/null

chmod 1777 "$ROOT/tmp" "$ROOT/var/tmp"
chown -R 10001:10001 "$ROOT/home/dev" 2>/dev/null || true

tar -C "$ROOT" -cf - . | docker import \
  --change 'ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  --change 'WORKDIR /workspace' \
  --change 'CMD ["/usr/bin/sleep", "infinity"]' \
  - "$IMAGE" >/dev/null

echo "built $IMAGE"
docker image inspect --format '{{.Id}} {{.Size}} bytes' "$IMAGE"
