# syntax=docker/dockerfile:1
# The build stages run once, natively on the build machine's platform: the
# Next.js build is JavaScript and the same for every architecture, and
# building it again for linux/arm64 under QEMU emulation took about 25 of
# the image's 35 minutes. Only the stage "standalone" adapts the result to
# each target platform (native packages such as sharp, see
# scripts/standalone-arch.mjs).
FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS deps
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
# Next.js's deployment id (skew protection during a rolling update,
# next.config.ts): empty = v<version>-<commit> from the commit above,
# "off" = none.
ARG FLOWPLAN_DEPLOYMENT_ID=""
# "beta" or "release", shown in Settings → Über Flowplan (docker.yml).
ARG FLOWPLAN_CHANNEL=""
# The type check already runs in CI; image builds there skip it.
ARG FLOWPLAN_SKIP_TYPECHECK=""
# Next's build cache survives between builds as well.
# FLOWPLAN_E2E_BUILD emptied: an image is never the browser specs' build,
# whose server takes the demo sign-in (lib/e2e-build.ts) – whatever a build
# argument or a later ENV says.
RUN --mount=type=cache,target=/app/.next/cache FLOWPLAN_E2E_BUILD= npm run build
# Per target platform, still without emulation: packages built for another
# CPU are swapped for their twin of the target (e.g. sharp for arm64).
FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS standalone
ARG TARGETARCH
COPY --from=build /app/.next/standalone /out
COPY scripts/standalone-arch.mjs /tmp/standalone-arch.mjs
RUN --mount=type=cache,target=/root/.npm node /tmp/standalone-arch.mjs /out "$TARGETARCH"
# The PostgreSQL client tools (pg_dump, pg_restore, psql) for the backups of
# an instance on PostgreSQL (lib/pg-backup.ts): from the PostgreSQL project's
# own repository (Debian's are older), the newest major version – a client
# dumps servers up to its own version, never newer ones. Only the three
# programs and the packages of the libraries they link go into the image:
# the package postgresql-client-<n> also brings postgresql-client-common,
# whose wrappers are Perl scripts, and with them perl and libperl. Flowplan
# calls the programs in /usr/lib/postgresql/<n>/bin directly and needs no
# Perl; image scans listed Perl's findings (Pod::Text) all the same.
# curl only fetches the repository key here, in a stage of its own: image
# scans showed critical curl findings that Debian has no fix for, and
# Flowplan never needs it.
FROM node:26-trixie-slim AS pgclient
ARG PG_CLIENT_MAJOR=18
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg /out/bin \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && . /etc/os-release \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
  && cp /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc /etc/apt/sources.list.d/pgdg.list /out/ \
  && cd "/usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin" && cp pg_dump pg_restore psql /out/bin/ \
  && for lib in $(ldd /out/bin/* | awk '/=> \//{print $3}' | sort -u); do \
       owner=""; \
       for path in "$lib" "$(realpath "$lib")" "/usr$lib"; do \
         owner=$(dpkg -S "$path" 2>/dev/null | grep -v '^diversion by' | sed 's|: /.*||' | head -n1); \
         [ -n "$owner" ] && break; \
       done; \
       [ -n "$owner" ] || { echo "no package owns $lib" >&2; exit 1; }; \
       echo "$owner"; \
     done > /tmp/owners \
  && tr ',' '\n' < /tmp/owners | sed 's|^ *||; s|:.*||' | sort -u > /out/packages \
  && cat /out/packages
# Litestream, built from its released source (the module v0.5.18, checked
# against the Go checksum database) instead of taken from its image: the
# published 0.5.18 binary carries github.com/go-jose/go-jose/v4 4.1.4
# (CVE-2026-116587, a DoS when parsing JWKs with RSA keys), fixed in 4.1.6,
# and golang.org/x/net 0.60.0 (CVE-2026-78661, a DoS in x/net/html), fixed
# in 0.62.0. Only those are raised (with what x/net needs along); built
# like the official one (pure Go, CGO off, -s -w, the same version string). Back to the official image once
# a Litestream release ships both fixes.
FROM --platform=$BUILDPLATFORM golang:1.26.11-trixie AS litestream
ARG TARGETOS TARGETARCH
ENV GOFLAGS=-modcacherw GOTOOLCHAIN=local
RUN version=0.5.18 \
  && dir=$(cd /tmp && go mod download -json "github.com/benbjohnson/litestream@v$version" | sed -n 's/^\s*"Dir": "\(.*\)",$/\1/p') \
  && cp -r "$dir" /src && chmod -R u+w /src && cd /src \
  && go get github.com/go-jose/go-jose/v4@v4.1.6 golang.org/x/net@v0.62.0 \
  && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w -X main.Version=$version" -o /usr/local/bin/litestream ./cmd/litestream \
  && go version -m /usr/local/bin/litestream | grep -q 'go-jose/go-jose/v4\s*v4.1.6' \
  && go version -m /usr/local/bin/litestream | grep -q 'golang.org/x/net\s*v0.62.0' \
  && rm -rf /root/go /root/.cache /src
FROM node:26-trixie-slim AS runtime
LABEL org.opencontainers.image.title="Flowplan" \
  org.opencontainers.image.description="Documents, databases, whiteboards and a daily journal for teams – self-hosted." \
  org.opencontainers.image.source="https://github.com/yannicschuller/flowplan" \
  org.opencontainers.image.url="https://flowplan.org" \
  org.opencontainers.image.documentation="https://docs.flowplan.org/installation" \
  org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
# Certificates for HTTPS to the S3 endpoint (Litestream is a static binary).
# The base image's Debian packages get their security updates (apt and others
# fixed after the base image was built). Debian 13 (trixie) instead of 12:
# newer curl and glibc that get security fixes first.
# The PostgreSQL client tools come from the stage pgclient, their libraries
# (libpq from the same PostgreSQL repository) as packages; the build checks
# that every tool starts and that neither Perl nor curl is in the image.
# Health checks that call `curl` inside the container (Coolify's HTTP check)
# get docker/healthcheck-curl.mjs.
# util-linux brings setpriv (the entrypoint's drop to PUID:PGID) and flock (its
# lock on the data folder, one container per SQLite database), installed
# explicitly in case the base image drops it. npm, npx and corepack are only
# needed to build; the image runs node alone, and their bundled packages
# (undici, brace-expansion …) would otherwise be scanned as part of the image.
ARG PG_CLIENT_MAJOR=18
RUN --mount=type=bind,from=pgclient,source=/out,target=/pgclient \
  apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends ca-certificates util-linux \
  && install -d /usr/share/postgresql-common/pgdg "/usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin" \
  && cp /pgclient/apt.postgresql.org.asc /usr/share/postgresql-common/pgdg/ \
  && cp /pgclient/pgdg.list /etc/apt/sources.list.d/ \
  && apt-get update \
  && xargs -a /pgclient/packages apt-get install -y --no-install-recommends \
  && install -m 755 /pgclient/bin/* "/usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin/" \
  && for tool in pg_dump pg_restore psql; do "/usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin/$tool" --version; done \
  && ! ldd "/usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin/"* | grep 'not found' \
  && ! dpkg -l perl 'libperl*' 'libcurl*' curl postgresql-client-common 2>/dev/null | grep -q '^ii' \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --chmod=755 docker/healthcheck-curl.mjs /usr/local/bin/curl
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
# Several Flowplan processes behind one port (FLOWPLAN_PROCESSES, #383):
# the supervisor next to server.js; docker/entrypoint.sh starts it instead
# of server.js when FLOWPLAN_PROCESSES is more than 1.
COPY --chmod=644 scripts/processes.mjs /app/processes.mjs
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
# The rebuild of a stuck Litestream replica (docker/entrypoint.sh, marker
# litestream-reset with "remote"): deletes <S3_PREFIX>/db/ in the bucket,
# signed with the app's S3 library (bundled into the app, so copied here).
COPY --chmod=644 scripts/litestream-replica-reset.mjs /app/scripts/litestream-replica-reset.mjs
COPY --from=build --chown=node:node /app/node_modules/aws4fetch /app/node_modules/aws4fetch
# Any UID/GID (#193): Compose's user: "UID:GID" may run the image as a user
# without an entry in /etc/passwd. Everything it writes goes to the data
# folder, /tmp (HOME, see docker/entrypoint.sh) or Next's cache below; the
# app code stays read-only for it.
# awk, mkfifo and tee -p copy Litestream's output to the data folder's
# logs (docker/entrypoint.sh, ls_log_open); without them it is not saved.
RUN setpriv --version && flock --version && awk 'BEGIN { srand(); exit !(srand() > 0) }' && mkfifo --version > /dev/null && tee -i -p --version > /dev/null \
  && mkdir -p /app/.next/cache && chown node:node /app/.next/cache && chmod 1777 /app/.next/cache \
  && chmod 755 /app/scripts /app/lib /app/lib/db-driver \
  && setpriv --reuid=1000 --regid=1000 --clear-groups -- test -r /app/scripts/litestream-replica-reset.mjs
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
