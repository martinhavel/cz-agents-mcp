FROM node:20-alpine AS builder
WORKDIR /app

# better-sqlite3 (EE bulk-ingest store) is a native module — needs a toolchain on Alpine/musl.
RUN apk add --no-cache python3 make g++

# Copy workspace root manifest + shared package first (better layer caching)
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/eu-registry ./packages/eu-registry

RUN npm install --workspaces --include-workspace-root
RUN npm run build --workspace=@czagents/shared
RUN npm run build --workspace=@czagents/eu-registry

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache wget

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/eu-registry/dist ./packages/eu-registry/dist
COPY --from=builder /app/packages/eu-registry/package.json ./packages/eu-registry/package.json

ENV PORT=3030
EXPOSE 3030
CMD ["node", "packages/eu-registry/dist/http.js"]
