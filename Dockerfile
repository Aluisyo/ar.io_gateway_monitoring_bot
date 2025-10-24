FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm install -D typescript @types/node && \
    npm run build && \
    npm prune --production

# Create logs directory
RUN mkdir -p logs

# Run as non-root user
USER node

CMD ["node", "dist/index.js"]
