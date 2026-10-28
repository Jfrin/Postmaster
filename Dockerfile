# dev: full toolchain. Used by the ci, test, auth, undo and eval compose services.
FROM node:25-slim AS dev
WORKDIR /srv
RUN chown node:node /srv
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
CMD ["npm", "run", "ci"]

# build: compile TypeScript
FROM dev AS build
RUN npm run build

# runtime (default target): production deps and compiled JS only
FROM node:25-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /srv/dist ./dist
# The built-in "node" user is uid 1000, so it can write ./data on a typical Linux VM.
USER node
CMD ["node", "dist/main.js"]
