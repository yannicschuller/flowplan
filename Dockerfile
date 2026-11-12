# syntax=docker/dockerfile:1
# The build stages run once, natively on the build machine's platform: the
# Next.js build is JavaScript and the same for every architecture, and
# building it again for linux/arm64 under QEMU emulation took about 25 of
# the image's 35 minutes. Only the stage "standalone" adapts the result to
# each target platform (native packages such as sharp, see
# scripts/standalone-arch.mjs).
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm's download cache survives between builds (BuildKit cache mount).
RUN --mount=type=cache,target=/root/.npm npm ci
FROM deps AS build
COPY . .
# The CI checkout may be private (umask 077) and COPY keeps those modes; the
# app runs as node, so everything that ends up in the image must be readable.
RUN chmod -R a+rX /app
ENV NEXT_TELEMETRY_DISABLED=1
# The commit shown in the administration (.git is not in the build context):
# our workflow passes GIT_COMMIT, Coolify passes SOURCE_COMMIT.
ARG GIT_COMMIT=""
ARG SOURCE_COMMIT=""
# "beta" or "release", shown in Settings → Über Flowplan (docker.yml).
ARG FLOWPLAN_CHANNEL=""
# The type check already runs in CI; image builds there skip it.
ARG FLOWPLAN_SKIP_TYPECHECK=""
# Next's build cache survives between builds as well.
RUN --mount=type=cache,target=/app/.next/cache npm run build
# Per target platform, still without emulation: packages built for another
# CPU are swapped for their twin of the target (e.g. sharp for arm64).
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim AS standalone
ARG TARGETARCH
COPY --from=build /app/.next/standalone /out
COPY scripts/standalone-arch.mjs /tmp/standalone-arch.mjs
RUN --mount=type=cache,target=/root/.npm node /tmp/standalone-arch.mjs /out "$TARGETARCH"
FROM litestream/litestream:0.5.18 AS litestream
FROM node:26-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Flowplan" \
  org.opencontainers.image.description="Documents, databases, whiteboards and a daily journal for teams – self-hosted." \
  org.opencontainers.image.source="https://github.com/yannicschuller/flowplan" \
  org.opencontainers.image.url="https://flowplan.org" \
  org.opencontainers.image.documentation="https://docs.flowplan.org/installation" \
  org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
# Certificates for HTTPS to the S3 endpoint (Litestream is a static binary);
# curl for Coolify's HTTP healthcheck, which runs inside the container.
# The PostgreSQL client tools (pg_dump, pg_restore, psql) for the backups of
# an instance on PostgreSQL (lib/pg-backup.ts): from the PostgreSQL project's
# own repository (Debian's are version 15), the newest major version – a
# client dumps servers up to its own version, never newer ones.
# The base image's Debian packages get their security updates (apt and others
# fixed after the base image was built). npm, npx and corepack are only needed
# to build; the image runs node alone, and their bundled packages (undici,
# brace-expansion …) would otherwise be scanned as part of the image.
ARG PG_CLIENT_MAJOR=18
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && . /etc/os-release \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
  && /usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin/pg_dump --version \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
# Explicit modes: the checkout may be private (umask 077); the app runs as node.
COPY --chmod=644 docker/litestream.yml /etc/litestream.yml
COPY --chmod=755 docker/entrypoint.sh /app/entrypoint.sh
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 FLOWPLAN_DATA_DIR=/app/data
RUN mkdir /app/data && chown node:node /app/data
COPY --from=standalone --chown=node:node /out ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# The curated release notes for "Neu in Flowplan" (#223; next.config.ts also
# traces them into the standalone output).
COPY --from=build --chown=node:node /app/release-notes ./release-notes
# Emergency decryption of encrypted backups and objects (docs: storage).
COPY --chmod=644 scripts/decrypt.mjs /app/decrypt.mjs
# Instance move without the web interface (docs: Instanz umziehen):
# node /app/move.mjs --from <old instance> --token <move token>.
COPY --chmod=644 scripts/move.mjs /app/move.mjs
COPY --chmod=644 lib/instance-move-pull.ts /app/instance-move-pull.ts
# Database tools (docs: Datenbank wechseln): the migration between SQLite and
# PostgreSQL, node /app/scripts/db-migrate.mjs, with the schema it reads, the
# rebuild of the search index, node /app/scripts/db-search-rebuild.mjs, and
# the schema step of a deployment (cluster mode, the Helm chart's migration
# Job), node /app/scripts/db-schema.mjs.
COPY --chmod=644 scripts/db-migrate.mjs scripts/db-search-rebuild.mjs scripts/db-schema.mjs /app/scripts/
COPY --chmod=644 lib/db-driver/pg-ddl.mjs lib/db-driver/postgres-schema.json /app/lib/db-driver/
# Any UID/GID (#193): Compose's user: "UID:GID" may run the image as a user
# without an entry in /etc/passwd. Everything it writes goes to the data
# folder, /tmp (HOME, see docker/entrypoint.sh) or Next's cache below; the
# app code stays read-only for it.
RUN setpriv --version \
  && mkdir -p /app/.next/cache && chown node:node /app/.next/cache && chmod 1777 /app/.next/cache
# Helper scripts started with docker exec (as root, see below) continue as
# PUID:PGID before they write anything (scripts/drop-root.mjs).
COPY --chmod=644 scripts/drop-root.mjs /app/drop-root.mjs
COPY --chmod=644 scripts/drop-root.mjs /app/scripts/drop-root.mjs
# No USER (#193), like the linuxserver.io images: the container starts as
# root only so that docker/entrypoint.sh can give the data folder to
# PUID:PGID (default 1000:1000, the user node); it then switches to that
# user with setpriv (util-linux, in the base image) before anything else
# runs – the app never runs as root. user: "UID:GID" (or Kubernetes'
# runAsUser) starts it as that user directly. docker exec and the
# HEALTHCHECK below run as root unless -u is given; the healthcheck only
# fetches /api/health and writes nothing, the helper scripts drop root
# themselves (FLOWPLAN_DROP_ROOT).
ENV FLOWPLAN_DROP_ROOT=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
VOLUME ["/app/data"]
CMD ["/app/entrypoint.sh"]
