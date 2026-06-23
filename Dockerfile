# Multi-stage build for vex-bot
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install all dependencies (including dev dependencies for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S vex && \
    adduser -S -u 1001 -G vex vex

# Copy built artifacts from builder
COPY --from=builder --chown=vex:vex /app/package*.json ./
COPY --from=builder --chown=vex:vex /app/dist ./dist
COPY --from=builder --chown=vex:vex /app/skills ./skills

# Install production dependencies only
RUN npm ci --omit=dev

# Create data directories for persistent storage
RUN mkdir -p /home/vex/.vex/logs \
    /home/vex/.vex/memory \
    /home/vex/.vex/cron \
    /home/vex/.vex/skills \
    /home/vex/.vex/sessions && \
    chown -R vex:vex /home/vex/.vex

# Switch to non-root user
USER vex

# Expose the web server port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info

# Use ENTRYPOINT for CLI, CMD provides default arguments
# Config should be provided via volume mount or environment variables
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start"]
