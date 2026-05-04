/**
 * Tenant environment-variable parsing for the ACP-spawned faucet agent.
 *
 * The host manager injects these env vars at container creation time; their
 * names + semantics are defined by the agentic-hosting Tenant Container
 * Contract (see agentic-hosting/ref_materials → 03-Tenant-CLI-Template.md).
 *
 * Source: trimmed from agentic-hosting/src/shared/config.ts (parseTenantConfig
 * + minimal types). Manager-side fields (host_id, controllers, docker socket)
 * are intentionally omitted — the faucet only runs as a tenant.
 */

import { SECP256K1_HEX_KEY_RE, pubkeysEqual } from './crypto.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TenantConfig {
  readonly manager_pubkey: string;
  readonly boot_token: string;
  readonly instance_id: string;
  readonly instance_name: string;
  readonly template_id: string;
  readonly network: string;
  readonly data_dir: string;
  readonly tokens_dir: string;
  readonly log_level: LogLevel;
  readonly heartbeat_interval_ms: number;
  readonly controller_pubkey: string | null;
}

function parsePositiveInt(name: string, raw: string, defaultValue: number, minValue?: number): number {
  if (raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }
  if (minValue !== undefined && parsed < minValue) {
    throw new Error(`${name} must be at least ${minValue}, got: ${parsed}`);
  }
  return parsed;
}

export function parseTenantConfig(env: Record<string, string | undefined> = process.env): TenantConfig {
  function req(name: string): string {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new Error(`Required environment variable ${name} is not set`);
    }
    return value;
  }

  const rawLevel = (env['UNICITY_LOG_LEVEL'] ?? 'info').toLowerCase();
  const logLevel: LogLevel = (LOG_LEVELS as readonly string[]).includes(rawLevel)
    ? (rawLevel as LogLevel)
    : 'info';

  const tenantManagerPubkey = req('UNICITY_MANAGER_PUBKEY');
  if (!SECP256K1_HEX_KEY_RE.test(tenantManagerPubkey)) {
    throw new Error('Invalid UNICITY_MANAGER_PUBKEY: must be a valid secp256k1 hex key');
  }

  // `|| null` — empty string maps to null (not "invalid hex").
  const controllerPubkey = env['UNICITY_CONTROLLER_PUBKEY'] || null;
  if (controllerPubkey !== null && !SECP256K1_HEX_KEY_RE.test(controllerPubkey)) {
    throw new Error('Invalid UNICITY_CONTROLLER_PUBKEY: must be a valid secp256k1 hex key');
  }
  // Privilege separation: a controller equal to the manager would silently win
  // the manager-only branch on the tenant side and could issue SHUTDOWN_GRACEFUL
  // / EXEC. Compared with pubkeysEqual to catch x-only-vs-compressed drift.
  if (controllerPubkey !== null && pubkeysEqual(controllerPubkey, tenantManagerPubkey)) {
    throw new Error(
      'UNICITY_CONTROLLER_PUBKEY must differ from UNICITY_MANAGER_PUBKEY — privilege separation requires distinct keys',
    );
  }

  return {
    manager_pubkey: tenantManagerPubkey,
    boot_token: req('UNICITY_BOOT_TOKEN'),
    instance_id: req('UNICITY_INSTANCE_ID'),
    instance_name: req('UNICITY_INSTANCE_NAME'),
    template_id: req('UNICITY_TEMPLATE_ID'),
    network: env['UNICITY_NETWORK'] ?? 'testnet',
    data_dir: env['UNICITY_DATA_DIR'] ?? '/data/wallet',
    tokens_dir: env['UNICITY_TOKENS_DIR'] ?? '/data/tokens',
    log_level: logLevel,
    heartbeat_interval_ms: parsePositiveInt(
      'UNICITY_HEARTBEAT_INTERVAL_MS',
      env['UNICITY_HEARTBEAT_INTERVAL_MS'] ?? '',
      5000,
      1000,
    ),
    controller_pubkey: controllerPubkey,
  };
}
