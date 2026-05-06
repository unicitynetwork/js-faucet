/**
 * Helper: spawn / list / stop tenants via sphere-cli's `sphere host …`
 * subcommand against a live host-manager (HMA).
 *
 * Bridges `manager-process.ts` (which provides the manager's address and
 * controller wallet binding) and `sphere-cli.ts` (which knows how to
 * invoke the binary). Each function here issues a single HMCP DM
 * round-trip via sphere-cli, parses the JSON response, and returns a
 * typed payload.
 *
 * The architectural intent (matching agentic-hosting's
 * SPHERE-CLI-EXTRACTION-PLAN §6.4):
 *   - `sphere host spawn` for tenant lifecycle (spawn, stop, list,
 *     inspect) — the controller talks to the HMA.
 *   - `sphere trader …` (or `trader-ctl`) for trade ops — the
 *     controller talks to the tenant directly, host-agnostic.
 *
 * This module covers the first half. The second half remains in
 * `trader-ctl-driver.ts` (and will gain a `sphere trader` mode in PR-C).
 */

import { runSphere, runSphereAsync, type SphereRunResult } from './sphere-cli.js';

/** Timeout passed to sphere-cli's `--timeout` flag (DM request budget). */
const DEFAULT_HMCP_TIMEOUT_MS = 120_000;

/**
 * Shape of `hm.spawn_ready` payload as emitted by sphere-cli's `--json`
 * mode. Mirrors the agentic-hosting protocol type
 * `HmSpawnReadyPayload` (instance_id, tenant_pubkey, tenant_direct_address,
 * tenant_nametag, state).
 */
export interface SpawnedTenant {
  readonly instanceId: string;
  readonly instanceName: string;
  /** secp256k1 chain pubkey of the spawned tenant's wallet. */
  readonly tenantPubkey: string;
  /** Canonical Unicity DIRECT://... address for ACP/trade-ops DMs. */
  readonly tenantDirectAddress: string;
  /** `@nametag` registration if the tenant succeeded; null if registration failed. */
  readonly tenantNametag: string | null;
  /** State per HMCP — always 'RUNNING' on success. */
  readonly state: string;
}

interface HmcpResponseEnvelope {
  readonly hmcp_version: string;
  readonly type: string;
  readonly in_reply_to: string;
  readonly payload: Record<string, unknown>;
}

function parseSpawnResponses(stdout: string): HmcpResponseEnvelope[] {
  // sphere-cli's --json mode prints the array of collected responses
  // pretty-printed. Strip surrounding noise (commander adds nothing,
  // but be defensive against future banners) by locating the first
  // `[` and last `]`.
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `sphere host spawn --json: could not find JSON array in stdout (start=${start} end=${end}). Raw: ${stdout.slice(0, 500)}`,
    );
  }
  const slice = stdout.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (err) {
    throw new Error(
      `sphere host spawn --json: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}\n` +
      `slice (first 800): ${slice.slice(0, 800)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`sphere host spawn --json: expected array, got ${typeof parsed}`);
  }
  return parsed as HmcpResponseEnvelope[];
}

export interface HostSpawnOpts {
  /** Path to the built sphere-cli binary. */
  cliPath: string;
  /** Test's controller-wallet CWD (passed to runSphere as cwd). */
  cliHome: string;
  /** Manager address — `@nametag`, `DIRECT://hex`, or raw hex pubkey. */
  managerAddress: string;
  /** Template ID, must exist in the HMA's templates.json. */
  templateId: string;
  /** Instance name (Docker label component; alphanumeric, _, ., - up to 63 chars). */
  instanceName: string;
  /** Per-DM timeout in ms. Default 120s — tenant Sphere.init can be slow on testnet. */
  timeoutMs?: number;
  /** Optional env overrides for the spawned tenant container. */
  env?: Record<string, string>;
}

/**
 * Issue `sphere host spawn` and return the typed `hm.spawn_ready`
 * payload. Throws if the spawn streamed `hm.spawn_failed` or
 * `hm.error`, or if the response payload is structurally invalid —
 * caller doesn't have to repeat the parse defensively.
 */
export function hostSpawn(opts: HostSpawnOpts): SpawnedTenant {
  const args = [
    'host',
    'spawn',
    opts.instanceName,
    '--manager', opts.managerAddress,
    '--template', opts.templateId,
    '--json',
    '--timeout', String(opts.timeoutMs ?? DEFAULT_HMCP_TIMEOUT_MS),
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('--env', `${k}=${v}`);
  }
  const result = runSphere(opts.cliPath, opts.cliHome, args, {
    timeoutMs: (opts.timeoutMs ?? DEFAULT_HMCP_TIMEOUT_MS) + 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `sphere host spawn failed (status=${result.status}, signal=${result.signal}). ` +
      `stderr: ${result.stderr.slice(0, 800)}\nstdout: ${result.stdout.slice(0, 800)}`,
    );
  }
  const responses = parseSpawnResponses(result.stdout);
  const ready = responses.find((r) => r.type === 'hm.spawn_ready');
  if (!ready) {
    const failed = responses.find((r) => r.type === 'hm.spawn_failed' || r.type === 'hm.error');
    throw new Error(
      `sphere host spawn did not produce hm.spawn_ready. ` +
      `last response: ${JSON.stringify(failed ?? responses[responses.length - 1])}`,
    );
  }
  const p = ready.payload;
  return {
    instanceId: String(p['instance_id'] ?? ''),
    instanceName: String(p['instance_name'] ?? ''),
    tenantPubkey: String(p['tenant_pubkey'] ?? ''),
    tenantDirectAddress: String(p['tenant_direct_address'] ?? ''),
    tenantNametag: typeof p['tenant_nametag'] === 'string' ? p['tenant_nametag'] : null,
    state: String(p['state'] ?? ''),
  };
}

/**
 * Async variant of hostSpawn — uses runSphereAsync so concurrent calls
 * (Promise.all([hostSpawnAsync(escrow), hostSpawnAsync(alice), ...]))
 * actually overlap. The sync version uses spawnSync which blocks the
 * event loop, defeating parallelism.
 */
export async function hostSpawnAsync(opts: HostSpawnOpts): Promise<SpawnedTenant> {
  const args = [
    'host',
    'spawn',
    opts.instanceName,
    '--manager', opts.managerAddress,
    '--template', opts.templateId,
    '--json',
    '--timeout', String(opts.timeoutMs ?? DEFAULT_HMCP_TIMEOUT_MS),
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('--env', `${k}=${v}`);
  }
  const result = await runSphereAsync(opts.cliPath, opts.cliHome, args, {
    timeoutMs: (opts.timeoutMs ?? DEFAULT_HMCP_TIMEOUT_MS) + 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `sphere host spawn failed (status=${result.status}, signal=${result.signal}). ` +
      `stderr: ${result.stderr.slice(0, 800)}\nstdout: ${result.stdout.slice(0, 800)}`,
    );
  }
  const responses = parseSpawnResponses(result.stdout);
  const ready = responses.find((r) => r.type === 'hm.spawn_ready');
  if (!ready) {
    const failed = responses.find((r) => r.type === 'hm.spawn_failed' || r.type === 'hm.error');
    throw new Error(
      `sphere host spawn did not produce hm.spawn_ready. ` +
      `last response: ${JSON.stringify(failed ?? responses[responses.length - 1])}`,
    );
  }
  const p = ready.payload;
  return {
    instanceId: String(p['instance_id'] ?? ''),
    instanceName: String(p['instance_name'] ?? ''),
    tenantPubkey: String(p['tenant_pubkey'] ?? ''),
    tenantDirectAddress: String(p['tenant_direct_address'] ?? ''),
    tenantNametag: typeof p['tenant_nametag'] === 'string' ? p['tenant_nametag'] : null,
    state: String(p['state'] ?? ''),
  };
}

export interface HostStopOpts {
  cliPath: string;
  cliHome: string;
  managerAddress: string;
  /** Either instanceName or instanceId works — sphere-cli accepts both. */
  target: string;
  timeoutMs?: number;
}

/**
 * Issue `sphere host stop` for a tenant. Best-effort: tolerates
 * already-stopped tenants and missing-instance errors so it's safe to
 * call from afterAll() without precise lifecycle bookkeeping.
 *
 * Async (returns a Promise) so callers can run multiple stops in
 * parallel via `Promise.all`/`Promise.allSettled`. The previous sync
 * implementation made parallelism impossible (each spawnSync blocked
 * the event loop, so .map(hostStop)+Promise.allSettled ran
 * sequentially), and three sequential 75s budgets approached the 240s
 * afterAll hookTimeout under any tenant slowdown.
 */
export async function hostStop(opts: HostStopOpts): Promise<SphereRunResult> {
  return runSphereAsync(
    opts.cliPath,
    opts.cliHome,
    [
      'host',
      'stop',
      opts.target,
      '--manager', opts.managerAddress,
      '--timeout', String(opts.timeoutMs ?? DEFAULT_HMCP_TIMEOUT_MS),
    ],
    { timeoutMs: (opts.timeoutMs ?? DEFAULT_HMCP_TIMEOUT_MS) + 15_000 },
  );
}

export interface HostListInstance {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly template_id: string;
  readonly state: string;
  readonly tenant_pubkey: string | null;
  readonly tenant_direct_address: string | null;
  readonly tenant_nametag: string | null;
}

/**
 * Issue `sphere host list --json` and return the parsed tenant list.
 * Useful for assertions like "after 3 spawns, list returns 3
 * RUNNING instances" without repeating the JSON-parse boilerplate.
 */
export function hostList(
  cliPath: string,
  cliHome: string,
  managerAddress: string,
  timeoutMs = DEFAULT_HMCP_TIMEOUT_MS,
): readonly HostListInstance[] {
  const result = runSphere(
    cliPath,
    cliHome,
    ['host', 'list', '--manager', managerAddress, '--json', '--timeout', String(timeoutMs)],
    { timeoutMs: timeoutMs + 15_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `sphere host list failed (status=${result.status}). stderr: ${result.stderr.slice(0, 500)}`,
    );
  }
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`sphere host list --json: no JSON object found. stdout: ${result.stdout.slice(0, 500)}`);
  }
  const obj = JSON.parse(result.stdout.slice(start, end + 1)) as { payload?: { instances?: HostListInstance[] } };
  // Throw on a structurally-malformed payload rather than silently
  // returning []. A list_result missing `payload.instances` is a
  // protocol contract violation (or a future field rename); pretending
  // it means "zero instances" would let an asserts-3-RUNNING test
  // pass with a misleading "expected 3, got 0" instead of pointing at
  // the real fault. Mirrors hostSpawn's strict parsing.
  if (!obj.payload || !Array.isArray(obj.payload.instances)) {
    // Echo only the top-level keys, not the full payload body — the
    // response could include peer pubkeys, instance IDs, or other
    // identifiers that don't belong in test logs (especially with
    // vitest's --reporter=json which captures errors to disk).
    const topKeys = Object.keys(obj);
    const payloadKeys = obj.payload && typeof obj.payload === 'object'
      ? Object.keys(obj.payload as Record<string, unknown>)
      : [];
    throw new Error(
      `sphere host list --json: response missing payload.instances. ` +
      `Top-level keys: [${topKeys.join(', ')}]. payload keys: [${payloadKeys.join(', ')}].`,
    );
  }
  return obj.payload.instances;
}
