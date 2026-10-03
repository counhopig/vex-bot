# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY skills ./skills
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production VEX_HOME=/data VEX_LOG_STDOUT=1 VEX_WEB_HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7860/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start"]
