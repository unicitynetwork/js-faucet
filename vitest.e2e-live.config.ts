/**
 * Live e2e test configuration — opt-in via `npm run test:e2e-live`.
 *
 * Tests run against REAL Unicity testnet infrastructure (Nostr relay,
 * L3 aggregator, IPFS gateway). They spawn the faucet image through
 * agentic-hosting's host-manager via `sphere host spawn` and send a
 * FAUCET_REQUEST DM directly to the spawned tenant.
 *
 * Before running:
 *   1. Build the faucet image:
 *        cd /path/to/parent && docker build \
 *          -f js-faucet/Dockerfile \
 *          -t ghcr.io/unicitynetwork/agentic-hosting/faucet:local .
 *   2. Build agentic-hosting:
 *        cd agentic-hosting && npm install && npm run build
 *   3. Build sphere-cli:
 *        cd sphere-cli && npm install && npm run build
 *   4. Set env vars (or rely on developer-fallback paths):
 *        AGENTIC_HOSTING_PATH=/path/to/agentic-hosting
 *        SPHERE_CLI_PATH=/path/to/sphere-cli/bin/sphere.mjs (auto-discovered)
 *   5. Run: `npm run test:e2e-live`
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e-live/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 240_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    reporters: ['default'],
  },
});
