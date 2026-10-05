# --- deps: install once, reused by both the builder and runner stages ---
FROM node:22-alpine AS deps
WORKDIR /app
# A RAM-starved or slow-registry-egress deploy box can hit npm's default
# 5-min socket timeout / 2 retries before `npm ci` finishes, failing
# intermittently with ETIMEDOUT mid-download. Give it a long timeout and
# more retries so a slow tarball is waited out rather than aborting the build.
ENV npm_config_fetch_timeout=600000 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=180000
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# --- builder: generate the Prisma client and build the Next.js app ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL isn't needed to *generate* the client, only a placeholder to
# satisfy prisma.config.ts's env() lookup during the build step.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
# NEXT_PUBLIC_* vars are inlined into the client bundle by `next build` — the
# runtime env_file in docker-compose.yml is too late for these, so it has to
# come in as a build arg instead.
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY}
RUN npx prisma generate
RUN npm run build

# --- runner: production image ---
FROM node:22-alpine AS runner
# Links the GHCR package to its source repo (and that repo's Actions access).
LABEL org.opencontainers.image.source=https://github.com/jbuxxy/flow
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S flow -u 1001

COPY package.json package-lock.json .npmrc ./
# Reuse the builder's already-populated node_modules and strip dev deps
# offline, rather than a second `npm ci` against the registry — on a
# RAM-starved or slow-registry-egress box, a second full install can run for
# 25+ min and still fail with ETIMEDOUT, while `npm prune` touches no
# network. Bonus: the Prisma engines `prisma generate`
# fetched into the builder tree come along for free.
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
# .next is copied in owned by root (the builder stage's default user) but
# the app runs as the unprivileged `flow` user below — anything Next
# writes at runtime under .next/cache (fetch cache, image optimizer, etc.)
# needs that ownership fixed first, or it fails with EACCES. Bit us once
# already: an unwritable .next/cache/images caused next/image requests to
# hang under concurrent load instead of failing cleanly — see
# next.config.ts's `images.unoptimized` for the other half of that fix.
RUN chown -R flow:nodejs ./.next

USER flow
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
