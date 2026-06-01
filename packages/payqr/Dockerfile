FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/payqr ./packages/payqr

RUN npm install --workspaces --include-workspace-root
RUN npm run build --workspace=@czagents/shared
RUN npm run build --workspace=@czagents/payqr

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache wget

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/payqr/dist ./packages/payqr/dist
COPY --from=builder /app/packages/payqr/package.json ./packages/payqr/package.json

ENV PORT=3037
EXPOSE 3037
CMD ["node", "packages/payqr/dist/http.js"]
