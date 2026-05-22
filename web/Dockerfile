# Multi-stage Next.js + worker build. Single image, two entrypoints:
#   - web service:     `node server.js`               (Next.js standalone)
#   - worker service:  `node dist/worker/index.js`    (esbuild-bundled)

# ─── deps ────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    else pnpm install --no-frozen-lockfile; fi

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG GIT_SHA=dev
ARG BUILD_TIME=unknown
ARG BUILD_VERSION=0.0.0
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV BUILD_VERSION=$BUILD_VERSION
ENV NEXT_PUBLIC_GIT_SHA=$GIT_SHA
ENV NEXT_PUBLIC_BUILD_VERSION=$BUILD_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ─── runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Worker bundle. esbuild now inlines all deps into a single file, so no
# additional node_modules tracing is needed for the worker path.
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
# Drizzle migration .sql files. The worker reads these from /app/migrations
# on boot (see lib/db/migrate.ts). Kept outside dist/ so they're not
# re-bundled — esbuild can't bundle .sql files.
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/migrations ./migrations

USER nextjs
EXPOSE 3000

# Default = web. Compose overrides command for worker.
CMD ["node", "server.js"]
