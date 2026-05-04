/**
 * Live e2e: HMA → spawn faucet-agent → controller sends FAUCET_REQUEST DM
 * → faucet mints + sends → controller receives the result envelope and
 * (optionally) the actual tokens.
 *
 * This test is the canonical proof that the faucet works end-to-end
 * against real testnet infrastructure WITHOUT any HTTP layer:
 *   - no faucet HTTP REST surface
 *   - no in-tree CLI shim
 *   - all messaging is encrypted Sphere DMs
 *
 * Before running:
 *   1. Build the faucet image:
 *        cd /path/to/parent && docker build \
 *          -f js-faucet/Dockerfile \
 *          -t ghcr.io/unicitynetwork/agentic-hosting/faucet:local .
 *   2. Build agentic-hosting (`npm ci && npm run build`).
 *   3. Build sphere-cli (`npm ci && npm run build`).
 *   4. Run `npm run test:e2e-live` from this repo.
 *
 * The test materializes a temp templates.json that injects the
 * `faucet-agent` template and points at `:local` — agentic-hosting's
 * shared config/templates.json is NOT modified.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import type { DirectMessage } from '@unicitylabs/sphere-sdk';

import { probeSphereCli, type SphereCliProbe } from './helpers/sphere-cli.js';
import {
  spawnHostManager,
  checkAgenticHostingPath,
  type HostManagerProcess,
} from './helpers/manager-process.js';
import {
  hostSpawnAsync,
  hostStop,
  type SpawnedTenant,
} from './helpers/hma-spawn.js';

import {
  createAcpMessage,
  isAcpResultPayload,
  isAcpErrorPayload,
} from '../../src/acp-adapter/protocols/acp.js';
import { parseAcpJson, serializeMessage } from '../../src/acp-adapter/protocols/envelope.js';
import { pubkeysEqual } from '../../src/acp-adapter/shared/crypto.js';

// ---------------------------------------------------------------------------
// Skip gates
// ---------------------------------------------------------------------------

const cliProbe: SphereCliProbe = probeSphereCli();
const agenticProbe = checkAgenticHostingPath();
let managerBinPath = '';
let agenticReady = false;
if (agenticProbe.ok) {
  managerBinPath = join(agenticProbe.path, 'dist', 'host-manager.js');
  agenticReady = existsSync(managerBinPath);
}
const skip = !cliProbe.ok || !agenticReady;
const skipReason = !cliProbe.ok
  ? `sphere-cli not runnable: ${cliProbe.reason}`
  : !agenticProbe.ok
    ? agenticProbe.reason
    : !agenticReady
      ? `agentic-hosting binary missing at ${managerBinPath}`
      : '';

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

interface SuiteState {
  /** Controller-side Sphere instance — sends DMs to the faucet directly. */
  controllerSphere: Sphere;
  controllerPubkey: string;
  controllerDirectAddress: string;
  controllerDataDir: string;
  controllerTokensDir: string;

  /** Path to a separate cliHome for the spawn-via-sphere-cli step. */
  cliPath: string;
  cliHome: string;

  manager: HostManagerProcess;
  managerAddr: string;
  managerPubkey: string;

  faucet: SpawnedTenant;

  /** All temp dirs created — afterAll wipes them. */
  tempDirs: string[];
}

let state: SuiteState | null = null;

// Capture any incoming DMs from the faucet; key by command_id so the
// test can correlate request → response.
const incomingResponses = new Map<string, { type: string; payload: Record<string, unknown> }>();
let dmUnsubscribe: (() => void) | null = null;

const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

// ---------------------------------------------------------------------------

describe.skipIf(skip)('faucet HMA roundtrip (live testnet)', () => {
  if (skip) {
    console.warn(`[faucet-roundtrip] SKIPPED: ${skipReason}`);
  }

  beforeAll(async () => {
    if (skip) return;
    if (!cliProbe.ok) throw new Error('precondition gate inverted');

    const tempDirs: string[] = [];

    // -------------------------------------------------------------------
    // 1. Bootstrap controller Sphere wallet IN-PROCESS — we'll send the
    //    FAUCET_REQUEST DM ourselves rather than via sphere-cli, since
    //    sphere-cli doesn't yet have a `sphere faucet request` subcommand.
    // -------------------------------------------------------------------
    const controllerDataDir = mkdtempSync(join(tmpdir(), 'js-faucet-e2e-ctrl-'));
    const controllerTokensDir = join(controllerDataDir, 'tokens');
    tempDirs.push(controllerDataDir);

    // Download the testnet trustbase so the controller's oracle is real.
    const tbResp = await fetch(TRUSTBASE_URL, { signal: AbortSignal.timeout(30_000) });
    if (!tbResp.ok) throw new Error(`failed to fetch trustbase: HTTP ${String(tbResp.status)}`);
    const trustbasePath = join(controllerDataDir, 'trustbase.json');
    writeFileSync(trustbasePath, await tbResp.text());

    const controllerProviders = createNodeProviders({
      network: 'testnet',
      dataDir: controllerDataDir,
      tokensDir: controllerTokensDir,
      oracle: { trustBasePath: trustbasePath },
    });
    console.log('[faucet-roundtrip] bootstrapping controller wallet…');
    const { sphere: controllerSphere } = await Sphere.init({
      ...controllerProviders,
      autoGenerate: true,
      // Random nametag so we don't collide with prior test runs on the relay.
      nametag: `c-${randomUUID().slice(0, 12).replace(/-/g, '')}`,
      accounting: true,
      swap: false,
      market: false,
    });
    const controllerIdentity = controllerSphere.identity;
    if (!controllerIdentity) throw new Error('controller identity missing after Sphere.init');
    const controllerPubkey = controllerIdentity.chainPubkey;
    const controllerDirectAddress =
      controllerIdentity.directAddress ?? `DIRECT://${controllerPubkey}`;
    console.log(`[faucet-roundtrip] controller pubkey ${controllerPubkey.slice(0, 16)}…`);

    // Subscribe to incoming DMs from the (yet-to-be-spawned) faucet so
    // we don't miss the result envelope between sendDM and our await.
    dmUnsubscribe = controllerSphere.on('message:dm', (msg: DirectMessage) => {
      const acp = parseAcpJson(msg.content);
      if (acp === null) return;
      if (acp.type !== 'acp.result' && acp.type !== 'acp.error') return;
      const payload = acp.payload as Record<string, unknown>;
      const cmdId = typeof payload['command_id'] === 'string' ? payload['command_id'] : null;
      if (cmdId === null) return;
      incomingResponses.set(cmdId, { type: acp.type, payload });
    });

    // -------------------------------------------------------------------
    // 2. Set up sphere-cli home for `sphere host spawn` (separate from
    //    controller wallet — sphere-cli persists its own DM state via
    //    atomic temp+rename, so concurrent writers race within one home).
    //    Bootstrap a sphere-cli wallet whose pubkey == controllerPubkey
    //    is impossible (different mnemonic). For the spawn step the cli
    //    wallet just needs to be authorized via AUTHORIZED_CONTROLLERS.
    // -------------------------------------------------------------------
    // We use sphere-cli's wallet init to create a SEPARATE controller
    // identity for the HMCP spawn DM. The HMA accepts a comma-list of
    // authorized controllers, so we authorize BOTH the in-process
    // controller (which sends FAUCET_REQUEST) AND the cli controller
    // (which sends `sphere host spawn`).
    const cliHome = mkdtempSync(join(tmpdir(), 'js-faucet-e2e-cli-'));
    tempDirs.push(cliHome);
    // Materialize an empty .sphere-cli config so sphere-cli sees a valid CWD
    const cfgDir = join(cliHome, '.sphere-cli');
    require('node:fs').mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({ network: 'testnet', dataDir: cfgDir, tokensDir: join(cfgDir, 'tokens') }),
    );

    console.log('[faucet-roundtrip] bootstrapping sphere-cli controller…');
    const { bootstrapControllerWallet } = await import('./helpers/sphere-cli.js');
    const cliCtrl = bootstrapControllerWallet(cliProbe.path, cliHome);
    console.log(`[faucet-roundtrip] cli-controller pubkey ${cliCtrl.pubkey.slice(0, 16)}…`);

    // -------------------------------------------------------------------
    // 3. Override agentic-hosting templates.json to inject the
    //    `faucet-agent` template + point trader to :local.
    // -------------------------------------------------------------------
    const baseTemplatesPath = join(agenticProbe.ok ? agenticProbe.path : '', 'config', 'templates.json');
    const baseTemplates = JSON.parse(readFileSync(baseTemplatesPath, 'utf8')) as {
      templates: Array<{ template_id: string; image: string; entrypoint?: string[]; env_defaults?: Record<string, string>; resources?: Record<string, unknown> }>;
    };
    if (!baseTemplates.templates.some((t) => t.template_id === 'faucet-agent')) {
      baseTemplates.templates.push({
        template_id: 'faucet-agent',
        image: 'ghcr.io/unicitynetwork/agentic-hosting/faucet:local',
        entrypoint: ['node', '/app/dist/acp-adapter/main.js'],
        env_defaults: {
          LOG_LEVEL: 'info',
          SPHERE_NETWORK: 'testnet',
        },
        resources: { memory_mb: 512, pids_limit: 256 },
      });
    } else {
      // Already present (e.g. operator added it locally) — point at :local for the test
      for (const t of baseTemplates.templates) {
        if (t.template_id === 'faucet-agent') {
          t.image = 'ghcr.io/unicitynetwork/agentic-hosting/faucet:local';
        }
      }
    }
    const tplDir = mkdtempSync(join(tmpdir(), 'js-faucet-e2e-tpl-'));
    tempDirs.push(tplDir);
    const customTemplatesPath = join(tplDir, 'templates.json');
    writeFileSync(customTemplatesPath, JSON.stringify(baseTemplates, null, 2));

    // -------------------------------------------------------------------
    // 4. Boot the host-manager. Authorize BOTH the cli-controller (for
    //    the spawn DM) and the in-process controller (for FAUCET_REQUEST
    //    if the faucet ever needs to verify sender against an allowlist —
    //    currently it doesn't, but it's hygienic).
    // -------------------------------------------------------------------
    console.log('[faucet-roundtrip] booting host-manager…');
    const manager = await spawnHostManager({
      controllerPubkey: [cliCtrl.pubkey, controllerPubkey].join(','),
      templatesPath: customTemplatesPath,
    });
    await manager.ready;
    const managerAddr = manager.nametag ? `@${manager.nametag}` : manager.pubkey;
    console.log(`[faucet-roundtrip] manager ready @ ${managerAddr}`);

    // -------------------------------------------------------------------
    // 5. Spawn the faucet via sphere host spawn (HMCP DM).
    // -------------------------------------------------------------------
    console.log('[faucet-roundtrip] spawning faucet…');
    const faucet = await hostSpawnAsync({
      cliPath: cliProbe.path,
      cliHome,
      managerAddress: managerAddr,
      templateId: 'faucet-agent',
      instanceName: `faucet-${randomUUID().slice(0, 6)}`,
      timeoutMs: 180_000,
    });
    console.log(
      `[faucet-roundtrip] faucet ready: pubkey=${faucet.tenantPubkey.slice(0, 16)}… ` +
      `nametag=${faucet.tenantNametag ?? '<none>'}`,
    );

    state = {
      controllerSphere,
      controllerPubkey,
      controllerDirectAddress,
      controllerDataDir,
      controllerTokensDir,
      cliPath: cliProbe.path,
      cliHome,
      manager,
      managerAddr,
      managerPubkey: manager.pubkey,
      faucet,
      tempDirs,
    };
  }, 600_000);

  afterAll(async () => {
    if (!state) return;
    const s = state;
    if (dmUnsubscribe) {
      try { dmUnsubscribe(); } catch { /* ignore */ }
    }
    try {
      await hostStop({
        cliPath: s.cliPath,
        cliHome: s.cliHome,
        managerAddress: s.managerPubkey,
        target: s.faucet.instanceName,
        timeoutMs: 60_000,
      });
    } catch (err) { console.warn('[faucet-roundtrip] hostStop failed:', err); }
    try { await s.manager.stop(); } catch { /* ignore */ }
    try { await s.controllerSphere.destroy(); } catch { /* ignore */ }
    for (const d of s.tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 240_000);

  // -------------------------------------------------------------------
  // Test cases
  // -------------------------------------------------------------------

  it('FAUCET_HELP returns the command catalog', async () => {
    if (!state) throw new Error('state missing');
    const s = state;

    const cmdId = randomUUID();
    const helpMsg = createAcpMessage('acp.command', 'controller', 'controller', {
      command_id: cmdId,
      name: 'FAUCET_HELP',
      params: {},
    });
    await s.controllerSphere.communications.sendDM(
      `DIRECT://${s.faucet.tenantPubkey}`,
      serializeMessage(helpMsg),
    );

    const response = await waitForResponse(cmdId, 60_000);
    expect(response.type).toBe('acp.result');
    if (!isAcpResultPayload(response.payload)) {
      throw new Error(`unexpected payload shape: ${JSON.stringify(response.payload)}`);
    }
    const result = response.payload.result as Record<string, unknown>;
    expect(result['adapter']).toBe('js-faucet');
    expect(Array.isArray(result['known_assets'])).toBe(true);
    expect((result['known_assets'] as string[]).includes('UCT')).toBe(true);
    expect((result['known_assets'] as string[]).includes('USDU')).toBe(true);
  });

  it('FAUCET_REQUEST mints UCT and sends to recipient', async () => {
    if (!state) throw new Error('state missing');
    const s = state;

    const cmdId = randomUUID();
    const reqMsg = createAcpMessage('acp.command', 'controller', 'controller', {
      command_id: cmdId,
      name: 'FAUCET_REQUEST',
      params: {
        recipient: s.controllerDirectAddress,
        asset: 'UCT',
        amount: '1000',
        memo: 'js-faucet roundtrip test',
      },
    });
    await s.controllerSphere.communications.sendDM(
      `DIRECT://${s.faucet.tenantPubkey}`,
      serializeMessage(reqMsg),
    );

    const response = await waitForResponse(cmdId, 180_000);
    if (response.type === 'acp.error') {
      const err = response.payload as Record<string, unknown>;
      throw new Error(
        `FAUCET_REQUEST returned error: code=${String(err['error_code'])} msg=${String(err['message'])}`,
      );
    }
    expect(response.type).toBe('acp.result');
    if (!isAcpResultPayload(response.payload)) {
      throw new Error(`unexpected payload shape: ${JSON.stringify(response.payload)}`);
    }
    const result = response.payload.result as { deliveries?: Array<Record<string, unknown>> };
    expect(Array.isArray(result.deliveries)).toBe(true);
    expect(result.deliveries).toHaveLength(1);
    const d = result.deliveries![0]!;
    expect(d['asset']).toBe('UCT');
    expect(d['amount']).toBe('1000');
    expect(typeof d['token_id']).toBe('string');
    expect(typeof d['transfer_id']).toBe('string');
    expect((d['token_id'] as string).length).toBeGreaterThan(8);
    expect((d['transfer_id'] as string).length).toBeGreaterThan(8);
  });

  it('FAUCET_REQUEST batch mints UCT + USDU', async () => {
    if (!state) throw new Error('state missing');
    const s = state;

    const cmdId = randomUUID();
    const reqMsg = createAcpMessage('acp.command', 'controller', 'controller', {
      command_id: cmdId,
      name: 'FAUCET_REQUEST',
      params: {
        recipient: s.controllerDirectAddress,
        items: [
          { asset: 'UCT', amount: '500' },
          { asset: 'USDU', amount: '500' },
        ],
      },
    });
    await s.controllerSphere.communications.sendDM(
      `DIRECT://${s.faucet.tenantPubkey}`,
      serializeMessage(reqMsg),
    );

    const response = await waitForResponse(cmdId, 240_000);
    if (response.type === 'acp.error') {
      const err = response.payload as Record<string, unknown>;
      throw new Error(
        `FAUCET_REQUEST batch returned error: code=${String(err['error_code'])} msg=${String(err['message'])}`,
      );
    }
    expect(response.type).toBe('acp.result');
    if (!isAcpResultPayload(response.payload)) {
      throw new Error(`unexpected payload: ${JSON.stringify(response.payload)}`);
    }
    const result = response.payload.result as { deliveries?: Array<Record<string, unknown>> };
    expect(result.deliveries).toHaveLength(2);
    const symbols = result.deliveries!.map((d) => d['asset']);
    expect(symbols).toContain('UCT');
    expect(symbols).toContain('USDU');
  });

  it('FAUCET_REQUEST with unknown asset returns INVALID_ASSET error', async () => {
    if (!state) throw new Error('state missing');
    const s = state;

    const cmdId = randomUUID();
    const reqMsg = createAcpMessage('acp.command', 'controller', 'controller', {
      command_id: cmdId,
      name: 'FAUCET_REQUEST',
      params: {
        recipient: s.controllerDirectAddress,
        asset: 'NOTACOIN',
        amount: '100',
      },
    });
    await s.controllerSphere.communications.sendDM(
      `DIRECT://${s.faucet.tenantPubkey}`,
      serializeMessage(reqMsg),
    );

    const response = await waitForResponse(cmdId, 60_000);
    expect(response.type).toBe('acp.error');
    if (!isAcpErrorPayload(response.payload)) {
      throw new Error(`expected error payload, got: ${JSON.stringify(response.payload)}`);
    }
    expect(response.payload.error_code).toBe('INVALID_ASSET');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForResponse(
  cmdId: string,
  timeoutMs: number,
): Promise<{ type: string; payload: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = incomingResponses.get(cmdId);
    if (r) {
      incomingResponses.delete(cmdId);
      return r;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `waitForResponse: no acp.result/acp.error received for command_id=${cmdId} within ${timeoutMs}ms`,
  );
}
