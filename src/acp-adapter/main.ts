/**
 * js-faucet — ACP-wrapped DM agent.
 *
 * Spawns under agentic-hosting's Host Manager. On boot:
 *   - reads UNICITY_* env vars (tenant container contract)
 *   - bootstraps a fresh Sphere wallet (auto-generated mnemonic)
 *   - registers a `f-<instance_id-prefix>` nametag on the relay
 *   - sends acp.hello to the manager
 *   - subscribes to inbound DMs
 *
 * DM routing:
 *   - From manager_pubkey: handle acp.hello_ack, acp.ping, acp.heartbeat,
 *     acp.command (STATUS, SHUTDOWN_GRACEFUL).
 *   - From ANY signed sender: handle acp.command FAUCET_REQUEST and
 *     FAUCET_HELP. The faucet is intentionally open — anyone who can
 *     encrypt a Sphere DM to the faucet's pubkey can request a mint.
 *     Operators that want rate-limiting wrap the agent in a controller
 *     tier upstream (out of scope here).
 *
 * Per-sender bounds (defense in depth):
 *   - 64 KiB DM size limit (drop on exceed)
 *   - acp.ts_ms must be within freshness window
 *   - content-hash replay guard (per-sender, persisted to disk)
 *
 * The handshake with the manager is identical to escrow/trader so the HMA
 * doesn't need any agent-specific code path: the hello → hello_ack →
 * heartbeat lifecycle works as soon as the manager allowlists this
 * tenant's pubkey via the spawn DM.
 */

import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import type { DirectMessage } from '@unicitylabs/sphere-sdk';
import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseTenantConfig } from './shared/tenant-config.js';
import {
  createAcpMessage,
  isAcpCommandPayload,
  isAcpHelloAckPayload,
} from './protocols/acp.js';
import { isTimestampFresh, parseAcpJson, serializeMessage } from './protocols/envelope.js';
import { pubkeysEqual } from './shared/crypto.js';
import { resolveApiKey } from './shared/api-key.js';
import { createReplayGuard } from './shared/replay-guard.js';

import { handleFaucetRequest, type FaucetResult } from './faucet-handler.js';
import { listKnownSymbols } from './coin-registry.js';
import { logger } from '../utils/logger.js';

const DEFAULT_TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

const ADAPTER_NAME = 'js-faucet';
const ADAPTER_VERSION = '0.1';

/** Heartbeat interval bounds. */
const HEARTBEAT_MIN_MS = 1_000;
const HEARTBEAT_MAX_MS = 300_000;

/** Commands the manager controller is allowed to send. */
const MANAGER_SYSTEM_COMMANDS = new Set(['STATUS', 'SHUTDOWN_GRACEFUL']);

/** Commands ANY signed sender (incl. manager) is allowed to send. */
const PUBLIC_FAUCET_COMMANDS = new Set(['FAUCET_REQUEST', 'FAUCET_HELP']);

export async function startFaucet(): Promise<void> {
  const config = parseTenantConfig();

  const log = logger.child({
    component: 'faucet-acp',
    instance_id: config.instance_id,
    instance_name: config.instance_name,
  });

  // ---------------------------------------------------------------------------
  // 1. Read manager DIRECT address from env (injected by host manager)
  // ---------------------------------------------------------------------------
  const managerDirectAddress = process.env['UNICITY_MANAGER_DIRECT_ADDRESS'] ?? '';
  if (!managerDirectAddress) {
    log.error('UNICITY_MANAGER_DIRECT_ADDRESS not set');
    throw new Error('UNICITY_MANAGER_DIRECT_ADDRESS environment variable is required');
  }

  // ---------------------------------------------------------------------------
  // 2. Ensure data directories exist
  // ---------------------------------------------------------------------------
  mkdirSync(config.data_dir, { recursive: true });
  mkdirSync(config.tokens_dir, { recursive: true });

  // ---------------------------------------------------------------------------
  // 3. Download trustbase
  //
  // The trust base URL defaults to the canonical testnet doc on GitHub
  // but can be overridden via SPHERE_TRUSTBASE_URL — useful when running
  // against a self-hosted aggregator with its own fresh genesis (the URL
  // can point at any HTTP(S)-served file, including a local nginx mount
  // of the aggregator's /app/bft-config/trust-base.json).
  // ---------------------------------------------------------------------------
  const trustbaseUrl = process.env['SPHERE_TRUSTBASE_URL'] ?? DEFAULT_TRUSTBASE_URL;
  log.info({ url: trustbaseUrl }, 'downloading_trustbase');
  const tbResponse = await fetch(trustbaseUrl, { signal: AbortSignal.timeout(30_000) });
  if (!tbResponse.ok) {
    throw new Error(`Failed to download trustbase: HTTP ${String(tbResponse.status)}`);
  }
  const trustbasePath = join(config.data_dir, 'trustbase.json');
  writeFileSync(trustbasePath, await tbResponse.text());

  // ---------------------------------------------------------------------------
  // 4. Initialize Sphere wallet — accounting ON (for mintFungibleToken),
  //    swap/market OFF (faucet doesn't trade or list).
  // ---------------------------------------------------------------------------
  const apiKey = resolveApiKey();

  // Optional Nostr-relay override. When `UNICITY_NOSTR_RELAYS` (or
  // `SPHERE_NOSTR_RELAYS` as a fallback) is set in the env, replace
  // the network preset's relay list. Use cases:
  //   - Local Docker relay for e2e harnesses (sphere-sdk's
  //     tests/e2e/local-infra) — keep aggregator + IPFS public, swap
  //     only the relay for one that we control + can rebuild
  //     deterministically.
  //   - Operators running against a private relay deployment without
  //     building a custom network preset.
  // Comma-separated list of WebSocket URLs ("ws://relay-1,wss://relay-2").
  // Empty / unset → use the network default. Whitespace + empty entries
  // are trimmed.
  const relayOverride = (() => {
    const raw =
      process.env['UNICITY_NOSTR_RELAYS'] ?? process.env['SPHERE_NOSTR_RELAYS'];
    if (!raw) return undefined;
    const relays = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return relays.length > 0 ? relays : undefined;
  })();
  if (relayOverride) {
    log.info({ relays: relayOverride }, 'nostr_relays_override_active');
  }

  // Optional aggregator URL override. When SPHERE_AGGREGATOR_URL is set
  // it replaces the network preset's aggregator (with the same use case
  // as the Nostr-relay override above — pointing at a self-hosted
  // deployment without building a custom network preset). When set, we
  // also enable skipVerification by default because a self-hosted
  // aggregator has its own freshly-minted trust base that won't match
  // the SDK's compiled-in test vectors. Override with
  // SPHERE_AGGREGATOR_SKIP_VERIFICATION=false if you've supplied
  // a matching SPHERE_TRUSTBASE_URL.
  const aggregatorUrl = process.env['SPHERE_AGGREGATOR_URL'];
  if (aggregatorUrl) {
    log.info({ url: aggregatorUrl }, 'aggregator_override_active');
  }
  const skipVerification = (() => {
    const v = process.env['SPHERE_AGGREGATOR_SKIP_VERIFICATION'];
    if (v === undefined) return aggregatorUrl ? true : undefined;
    return v === '1' || v.toLowerCase() === 'true';
  })();

  log.info({ network: config.network, data_dir: config.data_dir }, 'initializing_sphere');
  const providers = createNodeProviders({
    network: config.network as 'testnet' | 'mainnet' | 'dev',
    dataDir: config.data_dir,
    tokensDir: config.tokens_dir,
    oracle: {
      ...(aggregatorUrl ? { url: aggregatorUrl } : {}),
      ...(skipVerification !== undefined ? { skipVerification } : {}),
      trustBasePath: trustbasePath,
      apiKey,
    },
    ...(relayOverride ? { transport: { relays: relayOverride } } : {}),
  });

  // Default nametag pattern matches escrow/trader: a short type prefix +
  // 12-char hex slice of the instance UUID. Operators can override with
  // SPHERE_NAMETAG.
  const nametag = process.env['SPHERE_NAMETAG']
    ?? `f-${config.instance_id.replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
  log.info({ nametag }, 'registering_nametag');

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
    accounting: true,
    swap: false,
    market: false,
  });

  const identity = sphere.identity;
  if (!identity) {
    throw new Error('Sphere wallet initialization failed — no identity');
  }

  const walletPath = join(config.data_dir, 'wallet');
  log.warn(
    {
      wallet_path: walletPath,
      data_dir: config.data_dir,
    },
    'CRITICAL: faucet wallet must be backed up. Loss of wallet = inability to recover any unsent tokens.',
  );

  const faucetPubkey = identity.chainPubkey;
  const faucetDirectAddress = identity.directAddress ?? `DIRECT://${faucetPubkey}`;
  // Capture nametag in a const so closures below don't require re-narrowing
  // across the (effectively immutable) `sphere.identity` getter.
  const faucetNametag = identity.nametag ?? null;
  log.info(
    {
      pubkey: faucetPubkey.slice(0, 16) + '...',
      direct_address: faucetDirectAddress,
      nametag: identity.nametag ?? null,
      accounting: sphere.accounting !== null,
      known_assets: listKnownSymbols(),
    },
    'sphere_initialized',
  );
  // Dedicated boot signal carrying the FULL chainPubkey so external
  // harnesses (e.g., sphere-sdk's tests/e2e/local-infra) can scrape
  // stdout and learn where to send FAUCET_REQUEST DMs without going
  // through the manager handshake. Truncating the pubkey in the
  // structured `sphere_initialized` line above keeps human logs
  // readable; this separate line gives automation an exact match.
  log.info({ chain_pubkey: faucetPubkey }, 'faucet_chain_pubkey_announced');

  // Verify nametag is resolvable on the relay before declaring ready.
  if (identity.nametag) {
    const fName = `@${identity.nametag}`;
    const resolveFunc = (sphere as unknown as { resolve(id: string): Promise<{ directAddress?: string } | null> }).resolve.bind(sphere);
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const resolved = await resolveFunc(fName);
        if (resolved?.directAddress) {
          log.info({ nametag: identity.nametag, attempt }, 'nametag_verified');
          break;
        }
      } catch { /* retry */ }
      if (attempt < 10) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      } else {
        log.error({ nametag: identity.nametag }, 'nametag_verification_failed');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. acp.hello to manager (transitions container to RUNNING)
  // ---------------------------------------------------------------------------
  const managerAddress = config.manager_pubkey;
  const helloMsg = createAcpMessage('acp.hello', config.instance_id, config.instance_name, {
    boot_token: config.boot_token,
    tenant_pubkey: faucetPubkey,
    tenant_direct_address: faucetDirectAddress,
    tenant_nametag: identity.nametag ?? null,
    adapter: {
      name: ADAPTER_NAME,
      version: ADAPTER_VERSION,
      capabilities: ['heartbeat', 'ping', 'shutdown', 'status', 'faucet'],
      faucet: {
        commands: Array.from(PUBLIC_FAUCET_COMMANDS),
        known_assets: listKnownSymbols(),
      },
    },
  });
  await sphere.communications.sendDM(managerAddress, serializeMessage(helloMsg));
  log.info({ instance_id: config.instance_id }, 'hello_sent');

  // ---------------------------------------------------------------------------
  // 6. ACP DM subscription
  //
  // The handler routes by sender:
  //   - manager_pubkey: handshake / lifecycle / system commands
  //   - any signed sender: PUBLIC_FAUCET_COMMANDS
  // ---------------------------------------------------------------------------

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();

  // Per-sender content-hash replay guard. Persisted to disk so a captured
  // FAUCET_REQUEST can't be replayed across restart.
  const replayLogPath = join(config.data_dir, 'acp-replay.log');
  const acpReplayGuard = createReplayGuard(replayLogPath, {
    onPersistError: (err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'acp_replay_persist_error');
    },
  });

  const acpUnsubscribe = sphere.on('message:dm', (msg: DirectMessage) => {
    void handleIncomingDm(msg);
  });

  async function handleIncomingDm(msg: DirectMessage): Promise<void> {
    const senderPubkey = msg.senderPubkey;
    const content = msg.content;

    // Size cap (matches escrow/trader)
    if (content.length > 65536) return;

    const acpMsg = parseAcpJson(content);
    if (acpMsg === null) return;

    // Freshness gate — applied BEFORE replay guard so stale messages
    // don't poison the dedup cache.
    if (!isTimestampFresh(acpMsg.ts_ms)) {
      log.debug(
        { msg_id: acpMsg.msg_id, type: acpMsg.type, ts_ms: acpMsg.ts_ms },
        'acp_ts_ms_out_of_window',
      );
      return;
    }

    if (!acpReplayGuard.check(content)) {
      log.debug({ msg_id: acpMsg.msg_id, type: acpMsg.type }, 'acp_replay_rejected');
      return;
    }

    const fromManager = pubkeysEqual(senderPubkey, config.manager_pubkey);

    switch (acpMsg.type) {
      case 'acp.hello_ack': {
        if (!fromManager) return; // hello_ack from anyone else is meaningless
        if (!isAcpHelloAckPayload(acpMsg.payload)) {
          log.debug({ msg_id: acpMsg.msg_id }, 'acp_hello_ack_payload_invalid');
          return;
        }
        const payload = acpMsg.payload;
        if (payload.accepted === false) {
          log.warn({ instance_id: config.instance_id }, 'hello_ack_rejected');
          return;
        }
        delete process.env['UNICITY_BOOT_TOKEN'];

        const requested = typeof payload.heartbeat_interval_ms === 'number'
          ? payload.heartbeat_interval_ms
          : config.heartbeat_interval_ms;
        const interval = Math.min(Math.max(requested, HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
          const hb = createAcpMessage('acp.heartbeat', config.instance_id, config.instance_name, {
            status: 'ok',
            uptime_ms: Date.now() - startedAt,
            app: { mode: 'faucet', pid: process.pid },
          });
          sphere.communications.sendDM(managerAddress, serializeMessage(hb)).catch(() => { /* tolerate transient */ });
        }, interval);
        log.info({ heartbeat_interval_ms: interval }, 'hello_ack_received');
        return;
      }

      case 'acp.ping': {
        if (!fromManager) return; // ping is a manager-only liveness probe
        const pong = createAcpMessage('acp.pong', config.instance_id, config.instance_name, {
          in_reply_to: acpMsg.msg_id,
          ts_ms: Date.now(),
        });
        sphere.communications.sendDM(managerAddress, serializeMessage(pong)).catch((err: unknown) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'pong_send_failed');
        });
        return;
      }

      case 'acp.command': {
        if (!isAcpCommandPayload(acpMsg.payload)) {
          log.debug({ msg_id: acpMsg.msg_id }, 'acp_command_payload_invalid');
          return;
        }
        const cmdPayload = acpMsg.payload;
        const commandName = cmdPayload.name.toUpperCase();

        const isManagerCommand = MANAGER_SYSTEM_COMMANDS.has(commandName);
        const isPublicCommand = PUBLIC_FAUCET_COMMANDS.has(commandName);

        if (!isManagerCommand && !isPublicCommand) {
          await sendError(senderPubkey, cmdPayload.command_id, 'UNKNOWN_COMMAND', `Unknown command: ${cmdPayload.name}`);
          return;
        }

        if (isManagerCommand && !fromManager) {
          await sendError(senderPubkey, cmdPayload.command_id, 'FORBIDDEN', `Command ${cmdPayload.name} requires manager controller`);
          return;
        }

        // Public commands (FAUCET_REQUEST / FAUCET_HELP) are allowed from anyone
        // (the DM is encrypted-and-signed by the sender's secp256k1 key, so we
        // know who sent it; we just don't gate by allowlist here).

        if (commandName === 'STATUS') {
          await sendResult(senderPubkey, cmdPayload.command_id, {
            instance_id: config.instance_id,
            instance_name: config.instance_name,
            uptime_ms: Date.now() - startedAt,
            mode: 'faucet',
            pid: process.pid,
            faucet_pubkey: faucetPubkey,
            faucet_direct_address: faucetDirectAddress,
            faucet_nametag: faucetNametag,
            known_assets: listKnownSymbols(),
          });
          return;
        }

        if (commandName === 'SHUTDOWN_GRACEFUL') {
          await sendResult(senderPubkey, cmdPayload.command_id, { message: 'Shutdown initiated' });
          setTimeout(() => {
            shutdown('SHUTDOWN_GRACEFUL').catch(() => process.exit(1));
          }, 100);
          return;
        }

        if (commandName === 'FAUCET_HELP') {
          await sendResult(senderPubkey, cmdPayload.command_id, {
            adapter: ADAPTER_NAME,
            version: ADAPTER_VERSION,
            commands: {
              FAUCET_REQUEST: {
                description: 'Mint and send one or more cryptoassets to a recipient.',
                params: {
                  recipient: 'string — @nametag, DIRECT://hex, PROXY://hex, raw hex pubkey, or +E.164',
                  asset: 'string — symbol or 64-char hex coinId (single-asset form)',
                  amount: 'string — bigint in smallest units (single-asset form)',
                  memo: 'string — optional, ≤ 256 bytes',
                  items: 'array — multi-asset form, alternative to asset/amount: [{asset, amount, memo?}, ...]',
                },
              },
              FAUCET_HELP: { description: 'This help payload.', params: {} },
            },
            known_assets: listKnownSymbols(),
            limits: {
              max_per_asset_amount: '1000000000000000000',
              max_batch_items: 20,
              max_memo_bytes: 256,
            },
          });
          return;
        }

        if (commandName === 'FAUCET_REQUEST') {
          const result: FaucetResult = await handleFaucetRequest(
            { sphere, log },
            cmdPayload.params as unknown as Parameters<typeof handleFaucetRequest>[1],
          );
          if (result.ok) {
            await sendResult(senderPubkey, cmdPayload.command_id, {
              deliveries: result.deliveries,
            });
          } else {
            await sendError(
              senderPubkey,
              cmdPayload.command_id,
              result.error_code,
              result.message,
              result.partial !== undefined && result.partial.length > 0 ? { partial: result.partial } : undefined,
            );
          }
          return;
        }
        return;
      }

      default:
        return;
    }
  }

  async function sendResult(
    recipientPubkey: string,
    commandId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const msg = createAcpMessage('acp.result', config.instance_id, config.instance_name, {
      command_id: commandId,
      ok: true,
      result: data,
    });
    try {
      await sphere.communications.sendDM(`DIRECT://${recipientPubkey}`, serializeMessage(msg));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'result_send_failed');
    }
  }

  async function sendError(
    recipientPubkey: string,
    commandId: string,
    errorCode: string,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const msg = createAcpMessage('acp.error', config.instance_id, config.instance_name, {
      command_id: commandId,
      ok: false,
      error_code: errorCode,
      message,
      ...(extra !== undefined ? extra : {}),
    });
    try {
      await sphere.communications.sendDM(`DIRECT://${recipientPubkey}`, serializeMessage(msg));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'error_send_failed');
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Periodic sync loop — receive any returned tokens / fetch pending DMs.
  // ---------------------------------------------------------------------------

  const syncLoop = setInterval(async () => {
    try {
      await sphere.payments.receive({ finalize: true });
    } catch { /* tolerate */ }
    try {
      await (sphere as unknown as { fetchPendingEvents(): Promise<void> }).fetchPendingEvents();
    } catch { /* tolerate */ }
  }, 15_000);

  log.info(
    {
      pubkey: faucetPubkey.slice(0, 16) + '...',
      direct_address: faucetDirectAddress,
      data_dir: config.data_dir,
    },
    'faucet_running',
  );

  // ---------------------------------------------------------------------------
  // 8. Graceful shutdown
  // ---------------------------------------------------------------------------

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown_initiated');

    const hardKill = setTimeout(() => {
      log.error('shutdown_timeout — forcing exit');
      process.exit(1);
    }, 30_000);
    hardKill.unref();

    clearInterval(syncLoop);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (acpUnsubscribe) acpUnsubscribe();

    await sphere.destroy().catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'sphere_destroy_failed');
    });

    log.info('shutdown_complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}

function isMainModule(): boolean {
  try {
    const url = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    try {
      const realArgv1 = realpathSync(argv1);
      return url === realArgv1;
    } catch {
      return url === argv1 || url.endsWith(argv1) || argv1.endsWith(url);
    }
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startFaucet().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'faucet_acp_startup_failed');
    process.exit(1);
  });
}
