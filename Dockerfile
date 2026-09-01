FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run check:dashboard-assets \
    && npm run build

FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HERMES_LIVE_TASK_STATE_FILE=/var/lib/hermes-live/tasks-v1.json \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json* ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY LICENSE ./LICENSE
COPY --from=build /app/dist ./dist
COPY clients ./clients
COPY docs ./docs
COPY plugins ./plugins
RUN mkdir -p /var/lib/hermes-live \
    && chown node:node /var/lib/hermes-live \
    && chmod 700 /var/lib/hermes-live
USER node:node
EXPOSE 8788
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "const port=process.env.PORT||process.env.HERMES_LIVE_PORT||8788; fetch('http://127.0.0.1:'+port+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js", "serve"]
