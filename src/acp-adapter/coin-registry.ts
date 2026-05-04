/**
 * Coin registry — maps a human-readable asset symbol to its canonical
 * Unicity coinId hex. Used by FAUCET_REQUEST to accept either symbols
 * (`UCT`, `USDU`) or raw 64-char hex coinIds.
 *
 * Symbols here are the same ones the trader/escrow agents recognize
 * (sourced from the Unicity testnet token registry at
 * https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet.json).
 *
 * Adding a new asset:
 *   1. Confirm the coinId hex from the testnet token registry above.
 *   2. Add an entry below (uppercase symbol → lowercase 64-char hex).
 *   3. The FAUCET_REQUEST validator will then accept that symbol.
 */

const TESTNET_COINS: Readonly<Record<string, string>> = {
  UCT: '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89',
  USDU: '8f0f3d7a5e7297be0ee98c63b81bcebb2740f43f616566fc290f9823a54f52d7',
  EURU: '5e160d5e9fdbb03b553fb9c3f6e6c30efa41fa807be39fb4f18e43776e492925',
  DDSC: '99d512fcede11ae2df082bd403a33d8513746908a2ea3b6937f9784607505470',
  SOL: 'dee5f8ce778562eec90e9c38a91296a023210ccc76ff4c29d527ac3eb64ade93',
  USDT: '40d25444648418fe7efd433e147187a3a6adf049ac62bc46038bda5b960bf690',
  USDC: '2265121770fa6f41131dd9a6cc571e28679263d09a53eb2642e145b5b9a5b0a2',
  BTC: '86bc190fcf7b2d07c6078de93db803578760148b16d4431aa2f42a3241ff0daa',
  ETH: '3c2450f2fd867e7bb60c6a69d7ad0e53ce967078c201a3ecaa6074ed4c0deafb',
  ALPHT: 'cde78ded16ef65818a51f43138031c4284e519300ab0cb60c30a8f9078080e5f',
};

const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Resolve an asset string to a canonical 64-char lowercase hex coinId.
 * Accepts either a known symbol (case-insensitive) or a raw hex coinId.
 * Returns null on unknown/malformed input.
 */
export function resolveCoinId(asset: string): string | null {
  if (typeof asset !== 'string') return null;
  const trimmed = asset.trim();
  if (trimmed === '') return null;

  // Try as symbol (uppercase)
  const symbol = trimmed.toUpperCase();
  if (symbol in TESTNET_COINS) {
    return TESTNET_COINS[symbol]!;
  }

  // Try as raw hex (lowercase)
  const hex = trimmed.toLowerCase();
  if (HEX_64_RE.test(hex)) return hex;

  return null;
}

/**
 * List the symbol entries the registry knows about — used by the
 * FAUCET_HELP command to advertise the catalog.
 */
export function listKnownSymbols(): readonly string[] {
  return Object.keys(TESTNET_COINS);
}
