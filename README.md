# js-faucet

DM-driven testnet faucet agent for Unicity. Spawns under
[agentic-hosting](https://github.com/unicitynetwork/agentic-hosting) and
serves `FAUCET_REQUEST` commands over Sphere DMs (NIP-17 over Nostr) — no
HTTP, no public REST endpoint.

## How it works

```
   Caller (operator / trader / test)
        │
        │  acp.command FAUCET_REQUEST { recipient, asset, amount }
        ▼
   Sphere DM transport (encrypted, secp256k1-signed)
        │
        ▼
   js-faucet
        ├── mint via sphere.payments.mintFungibleToken
        └── send via sphere.payments.send → recipient
```

The faucet is intentionally open: anyone who can encrypt a Sphere DM to
the faucet's public key can request a mint. Operators that want
rate-limiting wrap the agent in a controller tier upstream.

## ACP commands

### `FAUCET_REQUEST` — single asset

```json
{
  "command_id": "<uuid>",
  "name": "FAUCET_REQUEST",
  "params": {
    "recipient": "@alice",
    "asset": "UCT",
    "amount": "5000",
    "memo": "topup"
  }
}
```

Recipient may be `@nametag`, `DIRECT://hex`, `PROXY://hex`, raw 64-char
hex pubkey, or `+E.164` phone-number nametag. Asset may be a known symbol
(`UCT`, `USDU`, `EURU`, …) or a 64-char hex coinId.

### `FAUCET_REQUEST` — multi-asset batch

```json
{
  "command_id": "<uuid>",
  "name": "FAUCET_REQUEST",
  "params": {
    "recipient": "@alice",
    "items": [
      { "asset": "UCT",  "amount": "5000" },
      { "asset": "USDU", "amount": "5000" }
    ]
  }
}
```

Up to 20 items per request. Each item is processed sequentially: mint,
then send. On the first failure the result returns
`partial: [<deliveries already completed>]` for reconciliation.

### Result shape

```json
{
  "command_id": "<uuid>",
  "ok": true,
  "result": {
    "deliveries": [
      {
        "asset": "UCT",
        "coin_id": "455ad8...",
        "amount": "5000",
        "token_id": "<hex>",
        "transfer_id": "<uuid>"
      }
    ]
  }
}
```

### `FAUCET_HELP`

Returns the command catalog and known assets — useful for clients that
want to discover capabilities at runtime.

## Tenant container contract

Spawned by the agentic-hosting Host Manager via the standard tenant
contract. Required env vars at boot:

- `UNICITY_MANAGER_PUBKEY`
- `UNICITY_MANAGER_DIRECT_ADDRESS`
- `UNICITY_BOOT_TOKEN`
- `UNICITY_INSTANCE_ID`, `UNICITY_INSTANCE_NAME`, `UNICITY_TEMPLATE_ID`
- `UNICITY_NETWORK`, `UNICITY_DATA_DIR`, `UNICITY_TOKENS_DIR`

Optional:
- `SPHERE_NAMETAG` — override the auto-generated `f-<id>` nametag.
- `LOG_LEVEL` — `info` (default), `debug`, `warn`.

The image's `CMD` runs `dist/acp-adapter/main.js` with `tini` as PID 1.
No ports are exposed — communication is DM-only.

## Bounds

- Max amount per asset per request: `10^18` smallest units.
- Max items per batch: `20`.
- Max memo length: `256` bytes (UTF-8).
- DM size cap: `64 KiB`.
- ACP `ts_ms` freshness window: spec default (replay-guard rejects
  duplicates within retention).

## Build

```bash
# from the parent dir holding both sphere-sdk/ and js-faucet/:
docker build \
  -f js-faucet/Dockerfile \
  -t ghcr.io/unicitynetwork/agentic-hosting/faucet:0.1 \
  .
```

## Local development

```bash
npm install
npm run build
npm test
```
