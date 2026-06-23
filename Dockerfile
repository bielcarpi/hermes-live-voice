FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY apps ./apps
COPY docs ./docs
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "const port=process.env.PORT||process.env.HERMES_LIVE_PORT||8788; fetch('http://127.0.0.1:'+port+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js", "serve"]
