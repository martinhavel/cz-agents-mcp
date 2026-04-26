FROM node:20-alpine AS builder
WORKDIR /app

# better-sqlite3 (used by sanctions + shared/billing) needs build tools
RUN apk add --no-cache python3 make g++

# Workspace root + every package dd depends on (shared, ares, sanctions, isir)
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/ares ./packages/ares
COPY packages/sanctions ./packages/sanctions
COPY packages/isir ./packages/isir
COPY packages/dd ./packages/dd

RUN npm install --workspaces --include-workspace-root
RUN npm run build --workspace=@czagents/shared
RUN npm run build --workspace=@czagents/ares
RUN npm run build --workspace=@czagents/sanctions
RUN npm run build --workspace=@czagents/isir
RUN npm run build --workspace=@czagents/dd

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache wget sqlite

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/ares/dist ./packages/ares/dist
COPY --from=builder /app/packages/ares/package.json ./packages/ares/package.json
COPY --from=builder /app/packages/sanctions/dist ./packages/sanctions/dist
COPY --from=builder /app/packages/sanctions/package.json ./packages/sanctions/package.json
COPY --from=builder /app/packages/isir/dist ./packages/isir/dist
COPY --from=builder /app/packages/isir/package.json ./packages/isir/package.json
COPY --from=builder /app/packages/dd/dist ./packages/dd/dist
COPY --from=builder /app/packages/dd/package.json ./packages/dd/package.json

# Optional persistent volume for sanctions data — when not mounted, dd
# silently runs without sanctions screening (still fully functional for
# ARES + ISIR + statutory checks).
VOLUME ["/var/lib/czagents-sanctions"]

# ISIR SOAP enabled by default — Glama / Anthropic test queries hit the
# real Czech Justice public WS (free, no auth).
ENV ISIR_SOAP_ENABLED=1

ENV PORT=3030
EXPOSE 3030

# Healthcheck so Glama's CI can verify the container is responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3030/health || exit 1

CMD ["node", "packages/dd/dist/http.js"]
