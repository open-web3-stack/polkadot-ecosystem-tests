# Running the Custom-Values DOT Bounty Lifecycle Test

End-to-end test that exercises the full **Multi-Asset Bounties** lifecycle on
**Kusama Asset Hub** with a DOT-as-foreign-asset bounty, using caller-supplied
values for `fund_bounty(asset_kind, value, curator, metadata)`.

The test runs against a Chopsticks fork of public Kusama Asset Hub at a pinned
block — no local node is required.

---

## What this test does

This test verifies that the `multiAssetBounties` pallet correctly handles the
**entire lifecycle** of a bounty denominated in **DOT held as a foreign asset
on Kusama Asset Hub**, end-to-end, when invoked with caller-supplied values
for the `fund_bounty` extrinsic.

### Why this test exists

Multi-asset bounties differ from traditional bounties in several ways the test
must cover:

- **No proposal phase** — the bounty is funded directly via `Treasurer` origin
  (no `proposeBounty` / `approveBounty` flow).
- **Async payments via the Paymaster** — funding (treasury → bounty pot) and
  payout (bounty pot → beneficiary) each go through `Pending → Attempted →
  Succeeded` states, advanced by anyone calling `checkStatus`.
- **Cross-chain assets** — `asset_kind` is an XCM `MultiLocation`, so the
  same code path must work for native KSM, USDT (Assets pallet), and DOT
  (ForeignAssets pallet).
- **Curator deposits in native token** — even when the bounty itself is paid
  in DOT/USDT, the curator's "skin in the game" deposit is held in KSM and
  released on success.

### Inputs

The test pins **four** caller-supplied values that match a real on-chain
`fund_bounty` call (see `packages/shared/src/multiAssetBounties.ts:1445-1447`):

| Field | Value | Meaning |
|-------|-------|---------|
| `value` | `10_000_000_000n` | 1 DOT (10 decimals) |
| `curator` | `0xe104…5e7c` | 32-byte AccountId pubkey of the proposed curator |
| `metadata` | freshly noted preimage hash | bounty description hash (the runtime stores only the hash, not the bytes) |
| `asset_kind` | V5 location: `Here`, assetId: `parents=2 / X1(GlobalConsensus(Polkadot))` | DOT held as a foreign asset on this chain |

### What it actually exercises on-chain

1. Treasury seeded with foreign DOT; a 1:1 DOT/KSM `assetRate` registered if
   absent (so `BalanceConverter` can satisfy the spend-origin check).
2. `multiAssetBounties.fundBounty(...)` is dispatched via the `Scheduler` with
   the `Treasurer` origin — emits `BountyCreated` and `Paid`, and the bounty
   pot account receives exactly `value` DOT from the treasury (asserted by
   matching the `foreignAssets.Transferred { from: treasury }` event).
3. **Direct foreign-asset transfer** — Alice is topped up with foreign DOT
   (via `dev.setStorage`) and then signs a real `foreignAssets.transfer`
   extrinsic to the bounty pot, asserting that anyone can deposit additional
   funds into the bounty account and the pallet will not double-count them.
4. `checkStatus` advances the funding payment from `Attempted → Succeeded`
   and the bounty status from `FundingAttempted → Funded`.
5. Because we don't hold the private key for the supplied curator pubkey, the
   bounty's encoded storage is patched with a **raw 32-byte substitution**
   that swaps the curator pubkey for `testAccounts.bob.publicKey`, with a
   guard that the supplied bytes appear exactly once in the encoded bounty.
6. Bob signs `acceptCurator` — locks the native-token curator deposit
   (`balances.Held { reason: MultiAssetBounties.CuratorDeposit }`), bounty
   transitions to `Active`.
7. Bob signs `awardBounty(bountyIndex, null, beneficiary=Charlie)` — emits
   `BountyAwarded`, initiates the payout payment, transitions to
   `PayoutAttempted`.
8. Final `checkStatus` finalizes the payout — emits
   `BountyPayoutProcessed`, releases the curator deposit, and removes the
   bounty from storage.

### Final assertions

- Charlie's foreign DOT balance increases by **exactly** `value`.
- The bounty pot retains **exactly** `ALICE_DOT_SEND` as residual (proving
  the pallet only spends its tracked `value`, not user-injected funds).
- `bounties(index)` is `None`.
- `curatorDeposit(index)` is `None` (deposit was returned).

### What this test does *not* cover

- Curator misbehavior / slashing paths.
- Funding-payment failure and retry.
- Child bounties (`fund_child_bounty`, payout splitting).
- Cross-chain payouts (beneficiary on a different parachain).
- Insufficient-permission and minimum-value error cases.

These are deliberate scope cuts; see `MULTI_ASSET_BOUNTIES_SETUP.md` for the
full Phase-2/3/4/5 backlog.

---

## 1. Prerequisites

- **Node.js** >= 20
- **Yarn** (Berry / v4) — `corepack enable && corepack prepare yarn@4.14.1 --activate`
- **git**, **macOS / Linux**

---

## 2. Clone the fork and check out the branch

```bash
git clone https://github.com/dhirajs0/polkadot-ecosystem-tests.git
cd polkadot-ecosystem-tests
git checkout multi-asset-bounties-e2e-tests
```

If you already cloned upstream and want to add this fork:

```bash
git remote add dhiraj https://github.com/dhirajs0/polkadot-ecosystem-tests.git
git fetch dhiraj multi-asset-bounties-e2e-tests
git checkout -b multi-asset-bounties-e2e-tests dhiraj/multi-asset-bounties-e2e-tests
```

---

## 3. Install dependencies

```bash
yarn install
```

This pulls 354+ MiB of packages on first install (Chopsticks pulls native
deps); subsequent installs are cached.

---

## 4. Run the custom test

```bash
yarn test:kusama -t "Should complete full DOT bounty lifecycle with custom call values"
```

What the test does (each step logs to stdout):

| Step | Action | Verifies |
|------|--------|----------|
| 1 | `multiAssetBounties.fundBounty(asset_kind, value, curator, metadata)` via Treasurer origin | `BountyCreated`, `Paid` events; bounty in `FundingAttempted` |
| 2 | Read bounty account from `foreignAssets.Transferred` event; assert it received `value` DOT | Bounty pot funded |
| 3 | Top up Alice with foreign DOT (via setStorage) and have Alice send some DOT to the bounty account | Alice debited, bounty credited |
| 4 | `checkStatus` → `Funded` | `BountyFundingProcessed` event |
| 5 | Raw 32-byte storage swap of curator pubkey → Bob | Bounty re-pointed at signer we control |
| 6 | `acceptCurator` (signed by Bob) | `BountyBecameActive`, deposit held |
| 7 | `awardBounty` to Charlie | `BountyAwarded`, `Paid` |
| 8 | Final `checkStatus` | `BountyPayoutProcessed`, deposit released, Charlie credited |

Expected output:

```
✓ Should complete full DOT bounty lifecycle with custom call values
[custom DOT lifecycle] charlie foreign DOT after payout: 10000000000
[custom DOT lifecycle] bounty account residual DOT after payout: 10000000000 (should equal alice send amount = 10000000000)
```

Run-time: ~30–60 seconds depending on RPC latency.

---

## 5. Customizing the call values

All knobs live at the **top of the test function** in
`packages/shared/src/multiAssetBounties.ts` (lines 1445–1447), near the JSDoc
that begins `Test: Complete DOT Bounty Lifecycle with caller-supplied values`.

```ts
const CUSTOM_DOT_BOUNTY_VALUE   = 10_000_000_000n          // 1 DOT (10 decimals)
const CUSTOM_DOT_CURATOR_PUBKEY = '0xe104b438…637a5e7c'    // 32-byte curator AccountId
const CUSTOM_DOT_BOUNTY_PREIMAGE_TEXT = 'Custom-values DOT bounty lifecycle'
```

### 5.1 `value` — bounty amount

The unit is the **smallest unit of the funded asset** (DOT has 10 decimals on
Polkadot, so `10_000_000_000n` = 1 DOT).

```ts
const CUSTOM_DOT_BOUNTY_VALUE = 50_000_000_000n   // 5 DOT
```

> The runtime asset rate must convert your value to ≥ `bountyValueMinimum` in
> the native token. `ensureDOTBountySetup()` registers a 1:1 KSM/DOT rate if
> one isn't already present, and seeds the treasury with `value × 100` foreign
> DOT, so you have ample headroom.

### 5.2 `curator` — 32-byte AccountId pubkey

Hex-encoded public key (`0x` + 64 hex chars). Pubkeys can be derived from any
SS58 address via `subkey inspect <ss58>` or polkadot.js's address book (look at
the "Public key (hex)" field).

```ts
const CUSTOM_DOT_CURATOR_PUBKEY = '0xabc123…def456'
```

> The test does not require a private key for this curator. After `fund_bounty`
> succeeds, it asserts the bytes are present in the encoded bounty, then
> performs a raw 32-byte hex substitution at the bounty's storage slot to swap
> in `testAccounts.bob.publicKey`. Bob then signs `acceptCurator` and
> `awardBounty`. If your custom pubkey appears more than once in the encoded
> bounty (e.g. is also the proposer), the test will fail an `expect()` guard
> instead of silently corrupting state.

### 5.3 `metadata` — preimage hash

The on-chain bounty stores only a 32-byte hash. The test calls
`createPreimage(client, CUSTOM_DOT_BOUNTY_PREIMAGE_TEXT)` which:

1. Submits `preimage.notePreimage(<utf8-bytes>)` from Alice
2. Returns the resulting blake2 hash as the `metadata` argument

To change the preimage content (and therefore the hash):

```ts
const CUSTOM_DOT_BOUNTY_PREIMAGE_TEXT = 'Bounty for X work, see ipfs://…'
```

> If you want to use a **specific** metadata hash you already have (e.g. from
> a dry run on a real chain), the chain must already store that preimage —
> otherwise pallet hooks that resolve the hash will fail. Without the original
> preimage bytes you cannot reproduce the hash. Either supply matching bytes
> here, or accept a freshly-generated hash.

### 5.4 `asset_kind` — XCM asset descriptor

Defined by `createDOTAssetKind()` in
`packages/shared/src/multiAssetBounties.ts:232`. The current value matches
**DOT held on Kusama Asset Hub** as a foreign asset:

```ts
{
  V5: {
    location: { parents: 0, interior: 'Here' },                  // current chain
    assetId:  { parents: 2, interior: { X1: [{ GlobalConsensus: 'Polkadot' }] } }
  }
}
```

To target a **different asset** (e.g. USDT on Asset Hub, asset id 1984), use
the corresponding helper or write your own:

| Asset | Helper | Definition |
|-------|--------|------------|
| Native KSM | `createNativeAssetKind()` | parents 0, Here |
| USDT (asset 1984) | `createUSDTAssetKind()` | parents 0, X2(PalletInstance 50, GeneralIndex 1984) |
| DOT (foreign) | `createDOTAssetKind()` | parents 0 / X1(GlobalConsensus(Polkadot)) |

If you change the asset kind, you usually also need to change:

- The treasury seeding in `ensureDOTBountySetup()` / `ensureUSDTBountySetup()`
- The balance-check helper used (`getForeignAssetBalance` for ForeignAssets,
  `getTreasuryAssetBalance` for the Assets pallet)
- The `value` magnitude (different decimals)

### 5.5 Alice's top-up & transfer (optional middle step)

In the same function:

```ts
const ALICE_DOT_TOPUP = 50_000_000_000n   // 5 DOT seeded to Alice if balance < send
const ALICE_DOT_SEND  = 10_000_000_000n   // amount Alice transfers to the bounty pot
```

Adjust to test partial funding scenarios. The post-condition asserts:

```
bountyAccount += ALICE_DOT_SEND
alice         -= ALICE_DOT_SEND
```

After the lifecycle completes, the bounty pays exactly `CUSTOM_DOT_BOUNTY_VALUE`
to Charlie, leaving `ALICE_DOT_SEND` in the bounty account as residual — the
test verifies this with the log line `bounty account residual DOT after payout: …`.

---

## 6. Inspecting events / state interactively

Drop one line at any inspection point:

```ts
await client.pause()
```

The test will halt and print `Listening on port <N>` to stdout. Open
[Polkadot.js Apps](https://polkadot.js.org/apps/), switch network → Development
→ Custom → `ws://localhost:<N>`, and browse Network → Explorer or
Developer → Chain state. `Ctrl+C` to end the test.

The test also has commented-out `// await logBountyLifecycleEvents(client, 'STEP …')`
markers; uncomment them (and re-add the helper from a previous commit if
needed) to print step-scoped event dumps.

---

## 7. Pinned block / endpoint overrides

Default endpoints are public Kusama Asset Hub RPCs and the test runs at the
block pinned in `KNOWN_GOOD_BLOCK_NUMBERS_KUSAMA.env`:

```
ASSETHUBKUSAMA_BLOCK_NUMBER=16399947
```

Override per run:

```bash
ASSETHUBKUSAMA_BLOCK_NUMBER=17000000 \
ASSETHUBKUSAMA_ENDPOINT=wss://asset-hub-kusama.dotters.network \
  yarn test:kusama -t "Should complete full DOT bounty lifecycle with custom call values"
```

---

## 8. Snapshots

The test asserts `multiAssetBounties.BountyPayoutProcessed` against a Vitest
snapshot at
`packages/kusama/src/__snapshots__/assetHubKusama.multiAssetBounties.e2e.test.ts.snap`.

If you intentionally change the asset kind, value, or beneficiary, regenerate
the snapshot:

```bash
yarn test:kusama -t "Should complete full DOT bounty lifecycle with custom call values" -u
```

---

## 9. Where things are

| File | Purpose |
|------|---------|
| `packages/kusama/src/assetHubKusama.multiAssetBounties.e2e.test.ts` | Wires the test tree to Kusama Asset Hub |
| `packages/shared/src/multiAssetBounties.ts` | All shared helpers + the test functions including `completeDOTBountyLifecycleCustomTest` (line ~1478) |
| `packages/networks/src/chains/assethub.ts` | `assetHubKusama` chain definition (endpoints, properties) |
| `KNOWN_GOOD_BLOCK_NUMBERS_KUSAMA.env` | Pinned block number for CI |
| `RUN_CUSTOM_DOT_BOUNTY_TEST.md` | This document |
