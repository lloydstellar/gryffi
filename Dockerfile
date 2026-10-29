# Gryffi Community Edition image
#
# Built from the root of the public repository:
#   docker build -t gryffi .

ARG NODE_VERSION=24

# Dependencies, including native modules (bcrypt, sharp)
FROM node:${NODE_VERSION}-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:${NODE_VERSION}-alpine
ARG GRYFFI_VERSION=dev
LABEL org.opencontainers.image.title="Gryffi Community Edition" \
      org.opencontainers.image.description="Interactive onboarding and training journeys for employees" \
      org.opencontainers.image.source="https://github.com/lloydstellar/gryffi" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${GRYFFI_VERSION}"

RUN apk add --no-cache postgresql16-client tini wget \
 # The app runs with node alone; package managers are not needed at runtime
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY app/ ./
COPY help-base/ /help-base/
COPY scripts/security/create-rls-role.sql scripts/security/create-app-runtime-role.sql /app/db-roles/
COPY docker/app/entrypoint.sh /usr/local/bin/gryffi-entrypoint

ENV NODE_ENV=production \
    GRYFFI_EDITION=community \
    GRYFFI_VERSION=${GRYFFI_VERSION}

RUN mkdir -p uploads logs && chown -R node:node uploads logs
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "gryffi-entrypoint"]
CMD ["node", "src/cluster.js"]
