# TA CODE workspace image.
#
# A development environment, not a distribution. Node, Python, Git, a shell and
# the tools a build actually invokes — and deliberately nothing else. Every
# package here is attack surface inside a container that runs other people's
# code, and an image that grows to please everybody ends up slow to pull, slow
# to start, and full of things nobody audits.
#
#   docker build -t ta-code/workspace:1 docker/workspace
#
# Pin by digest in production. `TACODE_IMAGE` takes whatever an operator
# resolves this tag to, so a workspace cannot silently change underneath users
# because a base image moved.

FROM ubuntu:24.04

# Never prompt, and never keep an apt cache in a layer.
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=development \
    # npm writes its cache and logs under HOME, which is a small tmpfs at
    # runtime. Pointing them at the workspace would put dependency caches in
    # the user's project; pointing them at /tmp keeps them out of both.
    NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      bash \
      coreutils \
      findutils \
      grep \
      sed \
      gawk \
      less \
      procps \
      tar \
      gzip \
      unzip \
      xz-utils \
      openssl \
      tini \
      python3.12 \
      python3.12-venv \
      python3-pip \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

# Node 22 from NodeSource. Ubuntu 24.04 ships an older Node, and a workspace
# whose Node predates the project's own is a support burden from day one.
ARG NODE_MAJOR=22
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm --version && node --version

RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.12 1 \
 && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1

# The user everything runs as. The uid is fixed and matches `--user` in the
# runtime's create arguments: the workspace is a bind mount from the host, so
# the ownership on both sides has to agree or nothing in it is writable.
RUN groupadd --gid 10001 dev \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash dev

# Git needs an identity to commit at all. A placeholder here means `git commit`
# fails with a message about configuring a name rather than an opaque error,
# and a real identity is set per project by the gateway.
RUN git config --system init.defaultBranch main \
 && git config --system advice.detachedHead false \
 # `/workspace` is a bind mount owned by a uid Git has not seen before; without
 # this Git refuses to operate in it at all.
 && git config --system --add safe.directory /workspace

WORKDIR /workspace

# `tini` as PID 1 so that orphaned processes are reaped. Without it a container
# accumulates zombies until it hits the pids limit — which is exactly the limit
# that exists to stop a fork bomb, reached by a build tool instead.
ENTRYPOINT ["/usr/bin/tini", "--"]

USER 10001:10001

# Overridden by the runtime, which keeps the container alive and delivers
# shells through `docker exec`. Declared so the image is runnable on its own.
CMD ["sleep", "infinity"]
