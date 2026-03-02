# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY . .

ARG NEXT_PUBLIC_HOTJAR_ID
ENV NEXT_PUBLIC_HOTJAR_ID=$NEXT_PUBLIC_HOTJAR_ID

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install curl for health checks and AWS CLI for S3 sync
RUN apk add --no-cache --no-check-certificate curl aws-cli

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3000

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy only necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/evaluation ./evaluation

# Copy and set up start script
COPY start-app.sh ./
RUN chmod +x start-app.sh

# Create writable directory for S3 sync
RUN mkdir -p /tmp/askWRI_docs && chown nextjs:nodejs /tmp/askWRI_docs

# Set correct ownership
RUN chown -R nextjs:nodejs /app

# Switch to non-root user
USER nextjs

# Expose the port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start the application
CMD ["./start-app.sh"]
