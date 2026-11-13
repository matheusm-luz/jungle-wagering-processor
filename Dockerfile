# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION}-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Image of the integration and concurrency suites: every dependency, sources and tests.
# The suites run here on every host, so signals and process control behave as on Linux (ADR-09).
FROM base AS test
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY test ./test
CMD ["bun", "test"]

# Application image. Bun runs the TypeScript sources directly; tsconfig.json must be present
# because the decorator settings NestJS depends on are read from it at run time.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# Exec form: Bun is PID 1 and receives SIGTERM itself, which graceful shutdown relies on.
CMD ["bun", "src/main.ts"]
