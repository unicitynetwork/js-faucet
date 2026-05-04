/**
 * ACP-0 envelope helpers — protocol detection, JSON serialization, prototype-pollution guards.
 *
 * Source: copied from agentic-hosting/src/protocols/envelope.ts during the
 * Phase 4(h) decoupling. Trimmed to the surface this adapter needs (ACP only;
 * HMCP is host-manager-only and not relevant inside a tenant).
 */

import { isValidAcpMessage } from './acp.js';
import type { AcpMessage } from './acp.js';

export const MAX_MESSAGE_SIZE = 64 * 1024;
export const MAX_NESTING_DEPTH = 20;

/**
 * Maximum acceptable clock skew between a message's `ts_ms` and local
 * `Date.now()` when deciding whether to treat a freshly-received message as
 * current. Defense-in-depth layered *above* the msg_id/content replay guard:
 * a captured message that slipped past dedup (e.g., replay log truncation,
 * cross-instance log loss, or a 30-day-old capture replayed on day 31 after
 * TTL expiry) must still carry a ts_ms no more than ±5 min from the
 * receiver's clock. 300s matches the sphere-cli / NIP-17 acceptance window
 * used across the Unicity stack.
 *
 * Used ONLY at inbound parse sites for freshly-delivered messages — NOT in
 * `isValid*` type guards, because unit tests build messages with literal
 * `ts_ms: 1000` (epoch + 1s) to keep fixtures stable. Structural validity is
 * orthogonal to liveness.
 */
export const MAX_CLOCK_SKEW_MS = 300_000;

/** Reject messages whose decoded JSON contains __proto__ / constructor / prototype keys. */
export function hasDangerousKeys(obj: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING_DEPTH) return true;
  if (typeof obj !== 'object' || obj === null) return false;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === 'object' && val !== null && hasDangerousKeys(val, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether `tsMs` is within ±MAX_CLOCK_SKEW_MS of `now` (defaulting to
 * the local wall clock). Returns false for non-finite inputs; callers should
 * treat stale/future messages the same as malformed ones (drop, warn, do not
 * propagate).
 *
 * Intentionally a simple symmetric window — NIP-17 transport is not strictly
 * ordered and a legitimate message can arrive slightly before `Date.now()`
 * when the sender's clock is slightly ahead. Asymmetric bounds (only reject
 * "future") would leak clock-skew info to the sender.
 */
export function isTimestampFresh(tsMs: number, now: number = Date.now()): boolean {
  if (typeof tsMs !== 'number' || !Number.isFinite(tsMs)) return false;
  return Math.abs(tsMs - now) <= MAX_CLOCK_SKEW_MS;
}

export function serializeMessage(msg: AcpMessage): string {
  return JSON.stringify(msg);
}

export function parseAcpJson(data: string): AcpMessage | null {
  if (data.length > MAX_MESSAGE_SIZE) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (hasDangerousKeys(parsed)) return null;
  if (!isValidAcpMessage(parsed)) return null;
  return parsed;
}
