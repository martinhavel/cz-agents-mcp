FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/ares ./packages/ares
COPY packages/sanctions ./packages/sanctions
COPY packages/dd ./packages/dd

RUN npm install --workspaces --include-workspace-root
RUN npm run build --workspace=@czagents/shared
RUN npm run build --workspace=@czagents/ares
RUN npm run build --workspace=@czagents/sanctions
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
COPY --from=builder /app/packages/dd/dist ./packages/dd/dist
COPY --from=builder /app/packages/dd/package.json ./packages/dd/package.json

ENV SANCTIONS_DB=/var/lib/czagents-sanctions/sanctions.db
VOLUME ["/var/lib/czagents-sanctions"]

ENV PORT=3030
EXPOSE 3030
CMD ["node", "packages/dd/dist/http.js"]
