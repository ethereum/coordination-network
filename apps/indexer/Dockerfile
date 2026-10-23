# built from the repository root, since the indexer depends on a workspace package:
# docker build -f apps/indexer/Dockerfile -t coordination-network-indexer .
FROM node:24-alpine AS build

WORKDIR /repo
# the whole repo, because an immutable install resolves every workspace in the lockfile
COPY . .
RUN yarn install --immutable
RUN yarn workspace @coordination-network/identity build

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /repo/apps/indexer
COPY --from=build /repo /repo

# the base image's unprivileged user, so a container escape does not start as root
USER node

CMD ["node", "--import", "tsx", "src/index.ts"]
