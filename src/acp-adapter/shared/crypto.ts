/**
 * Pubkey comparison helper for the ACP adapter.
 *
 * Source: trimmed from agentic-hosting/src/shared/crypto.ts during Phase 4(h)
 * decoupling. Only pubkeysEqual is needed here — the adapter compares the
 * incoming DM's senderPubkey against the configured manager pubkey, which can
 * differ in encoding (x-only vs compressed) across transport layers.
 */

import { timingSafeEqual } from 'node:crypto';

/** Matches valid secp256k1 hex keys: 64-char raw, 66-char compressed (02/03), 130-char uncompressed (04). */
export const SECP256K1_HEX_KEY_RE = /^[0-9a-fA-F]{64}$|^0[23][0-9a-fA-F]{64}$|^04[0-9a-fA-F]{128}$/;

export function isValidPubkey(pubkey: string): boolean {
  return SECP256K1_HEX_KEY_RE.test(pubkey);
}

function toXOnly(key: string): string | null {
  const k = key.toLowerCase();
  if (k.length === 64 && /^[0-9a-f]{64}$/.test(k)) return k;
  if (k.length === 66 && (k.startsWith('02') || k.startsWith('03'))) return k.slice(2);
  if (k.length === 130 && k.startsWith('04')) return k.slice(2, 66);
  return null;
}

/**
 * Timing-safe comparison of two secp256k1 public keys, tolerant of x-only /
 * compressed / uncompressed encoding mismatches. Returns false on malformed
 * input. Same-length 02/03 compressed keys with matching x-coords return false
 * (different y-parity = different identities).
 */
export function pubkeysEqual(a: string, b: string): boolean {
  if (!SECP256K1_HEX_KEY_RE.test(a) || !SECP256K1_HEX_KEY_RE.test(b)) return false;

  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();

  if (lowerA.length === lowerB.length) {
    const bufA = Buffer.from(lowerA, 'hex');
    const bufB = Buffer.from(lowerB, 'hex');
    if (bufA.length === 0 || bufB.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
  }

  const xA = toXOnly(lowerA);
  const xB = toXOnly(lowerB);
  if (!xA || !xB) return false;
  const bufA = Buffer.from(xA, 'hex');
  const bufB = Buffer.from(xB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
