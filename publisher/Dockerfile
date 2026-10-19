FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY client ./client
COPY agent ./agent
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 docker.io util-linux ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /publisher-data && chown node:node /publisher-data && chmod 700 /publisher-data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321 SERVERDESK_PUBLISHER_DATA_DIR=/publisher-data
USER node
VOLUME /publisher-data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:4321/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","build/server/publisher-main.js"]
