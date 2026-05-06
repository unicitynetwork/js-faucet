/**
 * ACP-0 (Agent Control Protocol) types, constructors, and validators.
 *
 * Source: copied from agentic-hosting/src/protocols/acp.ts during Phase 4(h)
 * decoupling. ACP-0 is owned by the agentic-hosting protocol spec (see
 * agentic-hosting/ref_materials → 02-ACP-MVP.md). This adapter implements
 * the tenant side; if the spec evolves, both repos must update in lockstep.
 */

import { randomUUID } from 'node:crypto';
import { hasDangerousKeys } from './envelope.js';

export const ACP_VERSION = '0.1';

export const ACP_MESSAGE_TYPES = [
  'acp.hello',
  'acp.hello_ack',
  'acp.heartbeat',
  'acp.ping',
  'acp.pong',
  'acp.command',
  'acp.result',
  'acp.error',
] as const;
export type AcpMessageType = (typeof ACP_MESSAGE_TYPES)[number];

export interface AcpHelloAckPayload {
  readonly accepted: boolean;
  readonly manager_pubkey: string;
  readonly heartbeat_interval_ms: number;
  readonly notes: string;
}

export interface AcpPongPayload {
  readonly in_reply_to: string;
  readonly ts_ms: number;
}

export interface AcpCommandPayload {
  readonly command_id: string;
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AcpResultPayload {
  readonly command_id: string;
  readonly ok: true;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface AcpErrorPayload {
  readonly command_id: string;
  readonly ok: false;
  readonly error_code: string;
  readonly message: string;
}

export interface AcpMessage {
  readonly acp_version: string;
  readonly msg_id: string;
  readonly ts_ms: number;
  readonly instance_id: string;
  readonly instance_name: string;
  readonly type: AcpMessageType;
  readonly payload: Record<string, unknown>;
}

export function createAcpMessage(
  type: AcpMessageType,
  instanceId: string,
  instanceName: string,
  payload: Record<string, unknown>,
): AcpMessage {
  return {
    acp_version: ACP_VERSION,
    msg_id: randomUUID(),
    ts_ms: Date.now(),
    instance_id: instanceId,
    instance_name: instanceName,
    type,
    payload,
  };
}

export function isValidAcpMessage(msg: unknown): msg is AcpMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj['acp_version'] === ACP_VERSION &&
    typeof obj['msg_id'] === 'string' && obj['msg_id'] !== '' &&
    Number.isFinite(obj['ts_ms']) &&
    typeof obj['instance_id'] === 'string' && obj['instance_id'] !== '' &&
    typeof obj['instance_name'] === 'string' && obj['instance_name'] !== '' &&
    typeof obj['type'] === 'string' &&
    (ACP_MESSAGE_TYPES as readonly string[]).includes(obj['type'] as string) &&
    typeof obj['payload'] === 'object' &&
    obj['payload'] !== null &&
    !hasDangerousKeys(obj)
  );
}

// ---- Typed payload guards ----
//
// Callers previously reached into `msg.payload` with `as unknown as
// AcpCommandPayload` / similar, bypassing type-guard validation. The casts
// compiled away and left the runtime trusting whatever shape the sender
// chose to send. These guards give callers a proper narrowing API so a field
// type mismatch is caught at the boundary with a single `if` instead of
// spreading `typeof x.name === 'string'` checks across handler bodies.

export function isAcpCommandPayload(payload: unknown): payload is AcpCommandPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p['command_id'] === 'string' && p['command_id'] !== '' &&
    typeof p['name'] === 'string' && p['name'] !== '' &&
    typeof p['params'] === 'object' && p['params'] !== null && !Array.isArray(p['params'])
  );
}

/**
 * Guard for acp.hello_ack payloads. `accepted` and `manager_pubkey` are
 * required; `heartbeat_interval_ms` and `notes` are treated as OPTIONAL at
 * runtime because the tenant falls back to its configured default interval
 * when the manager omits them. When PROVIDED, `heartbeat_interval_ms` MUST
 * be a finite, positive number — NaN/Infinity/<=0 must be rejected at the
 * wire boundary, not silently coerced (a malicious manager sending NaN
 * would otherwise drive `setInterval(NaN)` into a tight loop on the
 * tenant).
 */
export function isAcpHelloAckPayload(payload: unknown): payload is AcpHelloAckPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p['accepted'] !== 'boolean') return false;
  if (typeof p['manager_pubkey'] !== 'string') return false;
  if (p['heartbeat_interval_ms'] !== undefined) {
    if (
      typeof p['heartbeat_interval_ms'] !== 'number' ||
      !Number.isFinite(p['heartbeat_interval_ms']) ||
      (p['heartbeat_interval_ms'] as number) <= 0
    ) {
      return false;
    }
  }
  if (p['notes'] !== undefined && typeof p['notes'] !== 'string') return false;
  return true;
}

export function isAcpPongPayload(payload: unknown): payload is AcpPongPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p['in_reply_to'] === 'string' && p['in_reply_to'] !== '' &&
    typeof p['ts_ms'] === 'number' && Number.isFinite(p['ts_ms'])
  );
}

export function isAcpResultPayload(payload: unknown): payload is AcpResultPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p['command_id'] === 'string' && p['command_id'] !== '' &&
    p['ok'] === true &&
    typeof p['result'] === 'object' && p['result'] !== null && !Array.isArray(p['result'])
  );
}

export function isAcpErrorPayload(payload: unknown): payload is AcpErrorPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p['command_id'] === 'string' &&
    p['ok'] === false &&
    typeof p['error_code'] === 'string' && p['error_code'] !== '' &&
    typeof p['message'] === 'string'
  );
}
