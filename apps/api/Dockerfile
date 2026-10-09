# Build context is the repository root, so the workspace packages resolve.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile=false && pnpm -r build

FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
# Runs as a non-root user; the bind-mounted runtime directory must be owned by
# the matching uid or the first write fails with a permission error on a path
# that plainly exists.
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
