# js-faucet — DM-driven testnet faucet agent for Unicity.
#
# This image is consumed by the agentic-hosting Host Manager when it spawns
# a faucet tenant via Docker. CMD targets dist/acp-adapter/main.js (the
# tenant entrypoint that handles ACP-0 hello / heartbeat / ping / command).
#
# Build context:
#   - sphere-sdk sibling at ../sphere-sdk (until @unicitylabs/sphere-sdk
#     publishes the necessary exports to npm)
#   - js-faucet (this directory)
#
# Build:
#   cd /path/to/parent && \
#   docker build -f js-faucet/Dockerfile \
#                -t ghcr.io/unicitynetwork/agentic-hosting/faucet:0.1 \
#                .

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS build

WORKDIR /build

# sphere-sdk is consumed via `file:../sphere-sdk` and must be built first
# (its dist/ has to exist before js-faucet's npm install can resolve the
# file: link).
COPY sphere-sdk/ ./sphere-sdk/
COPY js-faucet/ ./js-faucet/

RUN cd sphere-sdk && npm ci && npm run build

# Install + build js-faucet (compiles src/ to dist/).
RUN cd js-faucet && npm install --no-audit --no-fund && npm run build

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

# tini handles PID-1 signal forwarding so SIGTERM from the host manager
# triggers our graceful-shutdown handler instead of being swallowed.
RUN apk add --no-cache tini

WORKDIR /app

# Copy compiled output + package files for production install.
COPY --from=build /build/js-faucet/dist ./dist/
COPY --from=build /build/js-faucet/package.json /build/js-faucet/package-lock.json ./
COPY --from=build /build/sphere-sdk/ ./sphere-sdk/

# Rewrite the file: dependency to the local copy in the image (the original
# `file:../sphere-sdk` would point outside the container). Then install only
# production deps. Mirror of escrow-service/Dockerfile:Stage-2.
RUN sed -i 's|"file:../sphere-sdk"|"file:./sphere-sdk"|' package.json \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund

# /data is the standard tenant data dir (mounted by HMA at runtime).
RUN mkdir -p /data/wallet /data/tokens && chown -R node:node /data /app

USER node

# No HTTP exposure — this is a DM-only agent.

ENTRYPOINT ["tini", "--"]
CMD ["node", "/app/dist/acp-adapter/main.js"]
