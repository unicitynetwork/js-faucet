/**
 * Pino logger — JSON Lines to stdout (matches the agentic-hosting tenant
 * container contract for log shape).
 */

import { pino } from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { component: 'faucet-acp' },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
});
