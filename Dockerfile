FROM node:22.22.1-bookworm-slim AS frontend-build
WORKDIR /build/frontend
# The sibling frontend is supplied as a named Compose build context.
# Explicit COPY lists keep local configuration and credentials out of images.
COPY --from=frontend /package.json /package-lock.json ./
RUN npm ci
COPY --from=frontend /index.html /tsconfig.json /vite.config.ts ./
COPY --from=frontend /src ./src
COPY --from=frontend /public ./public
RUN npm run build

FROM node:22.22.1-bookworm-slim AS backend-build
WORKDIR /build/backend
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 FRONTEND_DIST_DIR=/app/public
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=backend-build /build/backend/dist ./dist
COPY --from=frontend-build /build/frontend/dist ./public
COPY migrations ./migrations
USER node
EXPOSE 3000
# A failed migration prevents the API from starting. exec forwards shutdown signals.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/server.js"]
