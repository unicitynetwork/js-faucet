/**
 * FAUCET_REQUEST command handler.
 *
 * Accepts a request to mint one or more cryptoassets and send them to a
 * recipient. The recipient can be any address shape sphere-sdk's transport
 * layer resolves: `@nametag`, `DIRECT://hex`, `PROXY://hex`, raw 64-char
 * hex pubkey, or `+E.164` phone-number nametag.
 *
 * Wire shape (params, single-asset form):
 *   {
 *     command_id: string,
 *     recipient:  string,                  // resolved by sphere transport
 *     asset:      string,                  // 'UCT' / 'USDU' / hex coinId
 *     amount:     string,                  // bigint string, smallest units
 *     memo?:      string,                  // optional, max 256 chars
 *   }
 *
 * Wire shape (multi-asset form):
 *   {
 *     command_id: string,
 *     recipient:  string,
 *     items:      [{ asset, amount, memo? }, ...]  // 1-20 items
 *   }
 *
 * Result:
 *   { command_id, ok: true, result: {
 *       deliveries: [
 *         { asset, coin_id, amount, token_id, transfer_id },
 *         ...
 *       ]
 *     }
 *   }
 *
 * The handler does NOT impose a per-requester rate limit at this layer —
 * the operator is expected to wrap the agent in a rate-limiting tier
 * (e.g., a dedicated controller that throttles upstream). Anyone who can
 * encrypt a Sphere DM to the faucet's pubkey can call FAUCET_REQUEST,
 * matching the user's "anyone should be able to request" requirement.
 *
 * Bounds applied in this handler:
 *   - amount must be a positive bigint string ≤ MAX_PER_ASSET_AMOUNT
 *   - items list length ≤ MAX_BATCH_ITEMS
 *   - memo ≤ MAX_MEMO_BYTES
 *
 * Asset resolution: coin-registry.ts resolves symbols (UCT, USDU, …) to
 * canonical hex coinIds. Unknown symbols are rejected with INVALID_ASSET.
 */

import type { Sphere } from '@unicitylabs/sphere-sdk';
import type { Logger } from 'pino';

import { resolveCoinId } from './coin-registry.js';

// ---------------------------------------------------------------------------
// Bounds (all conservative; raise per environment if needed)
// ---------------------------------------------------------------------------

/** Maximum amount per asset per request (smallest units). */
const MAX_PER_ASSET_AMOUNT = 10n ** 18n;
/** Maximum number of items in a multi-asset batch. */
const MAX_BATCH_ITEMS = 20;
/** Maximum memo length in bytes (UTF-8). */
const MAX_MEMO_BYTES = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FaucetRequestItem {
  asset: string;
  amount: string;
  memo?: string;
}

export interface FaucetRequestParams {
  recipient: string;
  asset?: string;
  amount?: string;
  memo?: string;
  items?: readonly FaucetRequestItem[];
}

export interface FaucetDelivery {
  asset: string;
  coin_id: string;
  amount: string;
  token_id: string;
  transfer_id: string;
}

export interface FaucetSuccessResult {
  ok: true;
  deliveries: FaucetDelivery[];
}

export interface FaucetErrorResult {
  ok: false;
  error_code: string;
  message: string;
  /** Partial deliveries already completed before the failure (for diagnosis). */
  partial?: FaucetDelivery[];
}

export type FaucetResult = FaucetSuccessResult | FaucetErrorResult;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function safeParseBigint(s: unknown): bigint | null {
  if (typeof s !== 'string') return null;
  if (!/^\d+$/.test(s)) return null; // rejects empty, negative, decimals, scientific
  try {
    const n = BigInt(s);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function memoIsValid(memo: unknown): memo is string | undefined {
  if (memo === undefined) return true;
  if (typeof memo !== 'string') return false;
  if (Buffer.byteLength(memo, 'utf8') > MAX_MEMO_BYTES) return false;
  return true;
}

/**
 * Normalize the request into a list of items. Single-asset shape is
 * promoted to a one-element list. Throws an Error with a typed
 * `error_code` property if validation fails.
 */
function normalizeItems(params: FaucetRequestParams): FaucetRequestItem[] {
  if (typeof params.recipient !== 'string' || params.recipient.trim() === '') {
    throw makeErr('INVALID_PARAM', 'recipient must be a non-empty string');
  }
  if (params.items !== undefined) {
    if (!Array.isArray(params.items)) {
      throw makeErr('INVALID_PARAM', 'items must be an array');
    }
    if (params.items.length === 0) {
      throw makeErr('INVALID_PARAM', 'items must not be empty');
    }
    if (params.items.length > MAX_BATCH_ITEMS) {
      throw makeErr('INVALID_PARAM', `items must be ≤ ${String(MAX_BATCH_ITEMS)}`);
    }
    return params.items.map((it, i) => {
      if (typeof it !== 'object' || it === null) {
        throw makeErr('INVALID_PARAM', `items[${String(i)}] must be an object`);
      }
      if (typeof it.asset !== 'string') {
        throw makeErr('INVALID_PARAM', `items[${String(i)}].asset must be a string`);
      }
      if (!memoIsValid(it.memo)) {
        throw makeErr('INVALID_PARAM', `items[${String(i)}].memo invalid (max ${String(MAX_MEMO_BYTES)} bytes)`);
      }
      return { asset: it.asset, amount: it.amount, ...(it.memo !== undefined ? { memo: it.memo } : {}) };
    });
  }
  // Single-asset shape
  if (typeof params.asset !== 'string') {
    throw makeErr('INVALID_PARAM', 'asset must be a string (or use items: [...] for multi-asset)');
  }
  if (typeof params.amount !== 'string') {
    throw makeErr('INVALID_PARAM', 'amount must be a string (smallest units)');
  }
  if (!memoIsValid(params.memo)) {
    throw makeErr('INVALID_PARAM', `memo invalid (max ${String(MAX_MEMO_BYTES)} bytes)`);
  }
  return [{
    asset: params.asset,
    amount: params.amount,
    ...(params.memo !== undefined ? { memo: params.memo } : {}),
  }];
}

function makeErr(code: string, message: string): Error & { error_code: string } {
  const e = new Error(message) as Error & { error_code: string };
  e.error_code = code;
  return e;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface FaucetHandlerDeps {
  sphere: Sphere;
  log: Logger;
}

/**
 * Process one FAUCET_REQUEST. Mints + sends each item; on the first
 * failure returns FaucetErrorResult with the items already delivered in
 * `partial` so the caller can reconcile.
 */
export async function handleFaucetRequest(
  deps: FaucetHandlerDeps,
  params: FaucetRequestParams,
): Promise<FaucetResult> {
  const { sphere, log } = deps;

  let items: FaucetRequestItem[];
  try {
    items = normalizeItems(params);
  } catch (err) {
    const e = err as Error & { error_code?: string };
    return { ok: false, error_code: e.error_code ?? 'INVALID_PARAM', message: e.message };
  }

  // Pre-validate every item BEFORE doing any minting so we don't end up
  // with a partial delivery from a request that was DOA on item 5.
  const resolved: Array<{ symbol: string; coinId: string; amount: bigint; memo?: string }> = [];
  for (const [i, it] of items.entries()) {
    const coinId = resolveCoinId(it.asset);
    if (coinId === null) {
      return { ok: false, error_code: 'INVALID_ASSET', message: `items[${String(i)}].asset unknown: ${it.asset}` };
    }
    const amount = safeParseBigint(it.amount);
    if (amount === null) {
      return { ok: false, error_code: 'INVALID_PARAM', message: `items[${String(i)}].amount must be a positive integer string` };
    }
    if (amount > MAX_PER_ASSET_AMOUNT) {
      return { ok: false, error_code: 'AMOUNT_TOO_LARGE', message: `items[${String(i)}].amount > ${MAX_PER_ASSET_AMOUNT.toString()}` };
    }
    resolved.push({
      symbol: it.asset.toUpperCase(),
      coinId,
      amount,
      ...(it.memo !== undefined ? { memo: it.memo } : {}),
    });
  }

  const deliveries: FaucetDelivery[] = [];

  for (const r of resolved) {
    // Step 1: mint to self. mintFungibleToken returns
    //   { success: boolean, tokenId?: string, error?: string }
    const minted = await mintToSelf(sphere, r.coinId, r.amount, log);
    if (!minted.success || !minted.tokenId) {
      log.warn({ asset: r.symbol, coin_id: r.coinId.slice(0, 16), error: minted.error }, 'mint_failed');
      return {
        ok: false,
        error_code: 'MINT_FAILED',
        message: `mint failed for ${r.symbol}: ${minted.error ?? 'unknown'}`,
        partial: deliveries,
      };
    }

    // Step 2: send the freshly-minted asset to the recipient.
    // sphere.payments.send handles the address-resolution shape (@nametag,
    // DIRECT://, PROXY://, raw hex, +phone) — we don't need to pre-parse.
    const sendResult = await sendToRecipient(
      sphere,
      params.recipient.trim(),
      r.coinId,
      r.amount,
      r.memo,
      log,
    );
    if (!sendResult.ok || !sendResult.transferId) {
      log.warn(
        { asset: r.symbol, recipient: params.recipient.slice(0, 32), error: sendResult.error },
        'send_failed_after_mint',
      );
      return {
        ok: false,
        error_code: 'SEND_FAILED',
        message: `send failed for ${r.symbol}: ${sendResult.error ?? 'unknown'}`,
        partial: deliveries,
      };
    }

    deliveries.push({
      asset: r.symbol,
      coin_id: r.coinId,
      amount: r.amount.toString(),
      token_id: minted.tokenId,
      transfer_id: sendResult.transferId,
    });
    log.info(
      {
        asset: r.symbol,
        amount: r.amount.toString(),
        recipient_prefix: params.recipient.slice(0, 32),
        token_id: minted.tokenId.slice(0, 16),
        transfer_id: sendResult.transferId.slice(0, 16),
      },
      'faucet_delivery',
    );
  }

  return { ok: true, deliveries };
}

// ---------------------------------------------------------------------------
// Sphere wrappers — narrow the SDK's any-typed surface to what we need.
// ---------------------------------------------------------------------------

interface MintResult {
  success: boolean;
  tokenId?: string;
  error?: string;
}

async function mintToSelf(
  sphere: Sphere,
  coinIdHex: string,
  amount: bigint,
  log: Logger,
): Promise<MintResult> {
  // Type-narrow against an optional method — older SDKs didn't have it.
  const paymentsApi = sphere.payments as unknown as {
    mintFungibleToken?: (coinId: string, amount: bigint) => Promise<MintResult>;
  };
  if (!paymentsApi.mintFungibleToken) {
    log.error('mintFungibleToken not available on sphere.payments — SDK too old');
    return { success: false, error: 'mintFungibleToken not available on this sphere-sdk version' };
  }
  try {
    return await paymentsApi.mintFungibleToken(coinIdHex, amount);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface SendResult {
  ok: boolean;
  transferId?: string;
  error?: string;
}

async function sendToRecipient(
  sphere: Sphere,
  recipient: string,
  coinIdHex: string,
  amount: bigint,
  memo: string | undefined,
  log: Logger,
): Promise<SendResult> {
  try {
    // The SDK's `payments.send` request shape: { coinId, amount, recipient, memo? }.
    // The SDK resolves `recipient` via its transport layer (handles @nametag,
    // DIRECT://, PROXY://, raw hex, phone numbers).
    // SDK's TransferRequest carries `amount` as a string (smallest units);
    // we pass our bigint as a decimal string.
    //
    // transferMode='conservative': the SDK collects the inclusion proof on
    // the SENDER's side before delivering the wire payload. The recipient
    // receives a fully-finalized {sourceToken, transferTx} bundle and can
    // immediately produce a 'confirmed' Token with sdkData reflecting the
    // RECIPIENT's predicate (UnmaskedPredicate.create using the recipient's
    // signingService — see PaymentsModule.finalizeTransferToken).
    //
    // 'instant' mode (the default) instead sends a COMBINED_TRANSFER_V6
    // bundle — the recipient saves the token at status='submitted' with the
    // SENDER's sdkData and only swaps in the recipient-state-bound sdkData
    // AFTER the proof poll completes (PaymentsModule.finalizeReceivedToken,
    // line ~5395). When the recipient downstream tries to spend before
    // finalization replaces sdkData, the spend builds a commitment with
    // sourceState=sender's predicate, authenticator=recipient's key, and
    // the aggregator throws "Authenticator does not match source state
    // predicate." The trader's swap-deposit hits this race because:
    //   1. Trader portfolio shows "5000 confirmed UCT" (counted as
    //      confirmed even when the in-memory token is at 'submitted'? — see
    //      diagnostic notes; could also be a transient handle-bundle window
    //      where the token is briefly 'confirmed' with sender sdkData),
    //   2. Trader posts intent, deal hits ACCEPTED,
    //   3. Trader picks the not-yet-finalized token to fund the deposit,
    //   4. submitTransferCommitment rejects.
    // Conservative mode sidesteps the race entirely by handing the recipient
    // a token whose sdkData is already bound to its own predicate.
    const result = await sphere.payments.send({
      coinId: coinIdHex,
      amount: amount.toString(),
      recipient,
      transferMode: 'conservative',
      ...(memo !== undefined ? { memo } : {}),
    } as Parameters<typeof sphere.payments.send>[0]);
    // Newer SDKs return { id, status, ... }; treat status==='pending'/'sent' as ok.
    const r = result as unknown as { id?: string; transferId?: string; status?: string; success?: boolean; error?: string };
    const transferId = r.id ?? r.transferId;
    if (!transferId) {
      return { ok: false, error: r.error ?? 'send returned no transferId' };
    }
    return { ok: true, transferId };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'send_threw');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
