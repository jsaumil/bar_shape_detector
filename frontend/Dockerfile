# Rebar finder web UI (Next.js), built as a standalone server

# ---- build
FROM node:22-slim AS build
WORKDIR /app
RUN npm install -g bun@1.3.14

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Where the Next server forwards /api/* (the backend's Docker service name)
ARG BACKEND_URL=http://backend:8001
ENV BACKEND_URL=$BACKEND_URL NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---- run
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8000 HOSTNAME=0.0.0.0

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node

EXPOSE 8000
CMD ["node", "server.js"]
