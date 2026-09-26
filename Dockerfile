FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM litestream/litestream:0.5.17 AS litestream
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# Certificates for HTTPS to the S3 endpoint (Litestream is a static binary).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY docker/litestream.yml /etc/litestream.yml
COPY --chmod=755 docker/entrypoint.sh /app/entrypoint.sh
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 FLOWPLAN_DATA_DIR=/app/data
RUN mkdir /app/data && chown node:node /app/data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
VOLUME ["/app/data"]
CMD ["/app/entrypoint.sh"]
