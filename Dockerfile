# ---------- deps ----------
FROM node:24-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Only the manifests, so a source change does not invalidate the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN pnpm install --frozen-lockfile

# ---------- build ----------
FROM node:24-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time placeholders only. Runtime secrets come from compose env_file.
# .env.production is dockerignored so Next does not load incomplete host secrets.
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://cw:build@127.0.0.1:5432/cw_social?schema=public"
ENV REDIS_URL="redis://127.0.0.1:6379"
# Overridable at build time; runtime still uses compose env_file.
ARG APP_ORIGIN=http://localhost:3010
ARG APP_URL=http://localhost:3010
ENV APP_ORIGIN=$APP_ORIGIN
ENV APP_URL=$APP_URL
ENV SESSION_SECRET="YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="
ENV TOKEN_ENCRYPTION_KEY="YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="
ENV S3_ENDPOINT="https://s3.example.com"
ENV S3_REGION="auto"
ENV S3_BUCKET="cw-social"
ENV S3_ACCESS_KEY_ID="build"
ENV S3_SECRET_ACCESS_KEY="build"
ENV S3_FORCE_PATH_STYLE="true"
ENV MEDIA_PUBLIC_BASE_URL="https://media.example.com"

# Prisma generates into src/generated, so it must run before next build.
RUN pnpm prisma generate
RUN pnpm build
# Next may not create public/; Docker COPY requires the path to exist.
RUN mkdir -p public

# ---------- runtime ----------
FROM node:24-alpine AS runner
WORKDIR /app

# Sharp needs these on alpine; wget for compose healthchecks.
RUN apk add --no-cache libc6-compat vips-dev wget \
  && corepack enable \
  && corepack prepare pnpm@10.30.3 --activate

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Run as a non-root user. The app never needs to write to its own filesystem.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

USER nextjs
EXPOSE 3010

# Default command serves the web app. The worker overrides this in compose.
CMD ["pnpm", "start"]
