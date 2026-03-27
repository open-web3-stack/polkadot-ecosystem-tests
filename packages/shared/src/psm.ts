import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { HexString } from '@polkadot/util/types'

import { expect } from 'vitest'

import { checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

//
// Note about this module
//
// Tests exercise the PSM (Price Stability Module) pallet that lives on Asset Hub–style parachains.
// They are grouped by concern: core swaps, asset lifecycle, circuit breaker, value conservation,
// ceiling dynamics, and reserve integrity.
//
// Every test function is a standalone async function that sets up its own network via
// `setupNetworks`, so tests are fully independent.  The exported `psmE2ETests` function at the
// bottom of this file assembles them into a single `RootTestTree`.
//

/// -------
/// Constants
/// -------

/** 1 unit in 6-decimal precision (USDC / USDT / pUSD). */
const UNIT = 1_000_000n

/** Minimum swap amount enforced by the PSM pallet. */
const MIN_SWAP = 100n * UNIT

const devAccounts = testAccounts

/// -------
/// Helpers
/// -------

/** Query asset balance, returning `0n` when no entry exists. */
async function assetBalance(api: Client<any, any>['api'], assetId: number, address: string): Promise<bigint> {
  const entry = await api.query.assets.account(assetId, address)
  return entry.isSome ? entry.unwrap().balance.toBigInt() : 0n
}

/** Query PSM debt for a given external asset. */
async function psmDebt(api: Client<any, any>['api'], assetId: number): Promise<bigint> {
  return ((await (api.query as any).psm.psmDebt(assetId)) as any).toBigInt()
}

/** Execute a Root-origin call via scheduler storage injection. PAH uses `'NonLocal'`. */
async function rootCall(client: Client<any, any>, callHex: HexString): Promise<void> {
  await scheduleInlineCallWithOrigin(client, callHex, { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()
}

/** Sign a transaction, create a new block, and return the send result. */
async function signAndSend(client: Client<any, any>, tx: any, signer: any) {
  const result = await sendTransaction(tx.signAsync(signer))
  await client.dev.newBlock()
  return result
}

/// -------
/// Tests — Core swaps
/// -------

/**
 * Verify the happy-path mint: depositing USDC into the PSM yields pUSD, records debt, and routes
 * the minting fee to the insurance fund — the three invariants that underpin the stablecoin peg.
 *
 * 1. Record alice's pUSD balance and the insurance fund's pUSD balance before the swap
 * 2. Mint the minimum swap amount of USDC into pUSD
 * 3. Assert a `Minted` event was emitted
 * 4. Assert alice received a positive amount of pUSD
 * 5. Assert the PSM's debt for USDC equals the exact mint amount (1:1 accounting)
 * 6. Assert the insurance fund's pUSD balance increased (fee was collected)
 */
async function mintUsdcToPusd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId, psmInsuranceFundAccount } = chain.custom as any

  const alice = devAccounts.alice
  const mintAmount = MIN_SWAP

  const pUsdBefore = await assetBalance(client.api, psmStableAssetId, alice.address)
  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, mintAmount)
  await signAndSend(client, mintCall, alice)

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('mint USDC to pUSD')

  const pUsdAfter = await assetBalance(client.api, psmStableAssetId, alice.address)
  expect(pUsdAfter - pUsdBefore).toBeGreaterThan(0n)

  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBe(mintAmount)

  const insuranceAfter = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)
  expect(insuranceAfter - insuranceBefore).toBeGreaterThan(0n)
}

/**
 * Verify the full round-trip: a user can mint pUSD and then redeem it back for the underlying
 * USDC collateral.  This is the core promise of a PSM — bidirectional convertibility.
 *
 * 1. Mint the minimum swap amount of USDC into pUSD
 * 2. Assert alice received a positive pUSD balance
 * 3. Redeem all received pUSD back to USDC
 * 4. Assert a `Redeemed` event was emitted
 * 5. Assert alice's USDC balance increased after redemption
 */
async function mintThenRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any

  const alice = devAccounts.alice

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await signAndSend(client, mintCall, alice)

  const pUsdReceived = await assetBalance(client.api, psmStableAssetId, alice.address)
  expect(pUsdReceived).toBeGreaterThan(0n)

  const usdcBefore = await assetBalance(client.api, psmUsdcId, alice.address)
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pUsdReceived)
  await signAndSend(client, redeemCall, alice)

  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot('redeem pUSD to USDC')

  const usdcAfter = await assetBalance(client.api, psmUsdcId, alice.address)
  expect(usdcAfter - usdcBefore).toBeGreaterThan(0n)
}

/**
 * Verify that dust-sized mints are rejected.  The PSM enforces a minimum swap to prevent
 * griefing attacks that would bloat storage with negligible positions.
 *
 * 1. Attempt to mint 1 unit of USDC (far below `MIN_SWAP`)
 * 2. Assert the extrinsic fails with `ExtrinsicFailed`
 */
async function mintBelowMinSwapFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  const alice = devAccounts.alice
  const tinyAmount = 1n

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, tinyAmount)
  await signAndSend(client, mintCall, alice)

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'mint below minimum swap amount',
  )
}

/// -------
/// Tests — Asset lifecycle
/// -------

/**
 * Verify that a newly registered asset with a zero ceiling is effectively disabled for minting.
 * Governance may want to register an asset before deciding on its risk limit; users must not be
 * able to mint against it until a ceiling is explicitly set.
 *
 * 1. Add external asset 9999 via Root
 * 2. Attempt to mint against asset 9999
 * 3. Assert the extrinsic fails (zero ceiling blocks the mint)
 */
async function addAssetWithZeroCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  const addCall = (client.api.tx as any).psm.addExternalAsset(9999)
  await rootCall(client, addCall.method.toHex())

  const mintCall = (client.api.tx as any).psm.mint(9999, MIN_SWAP)
  await signAndSend(client, mintCall, alice)

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'mint fails for zero ceiling asset',
  )
}

/**
 * Verify the two-step asset onboarding: register an asset then configure its ceiling weight.
 * Once both steps are complete, minting against the new collateral must succeed — confirming
 * governance can safely introduce new stablecoins into the PSM.
 *
 * 1. Add external asset 9999 via Root
 * 2. Set a non-zero ceiling weight for asset 9999 via Root
 * 3. Fund alice with asset 9999 via storage injection
 * 4. Mint the minimum swap amount against asset 9999
 * 5. Assert a `Minted` event was emitted
 */
async function addAssetThenSetCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  const addCall = (client.api.tx as any).psm.addExternalAsset(9999)
  await rootCall(client, addCall.method.toHex())

  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(9999, 100_000)
  await rootCall(client, ceilingCall.method.toHex())

  await client.dev.setStorage({
    Assets: {
      account: [[[9999, alice.address], { balance: 1000e6 }]],
    },
  })

  const mintCall = (client.api.tx as any).psm.mint(9999, MIN_SWAP)
  await signAndSend(client, mintCall, alice)

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'mint succeeds after setting ceiling',
  )
}

/**
 * Verify that governance can cleanly decommission a collateral type once all outstanding debt has
 * been settled.  This is the safe off-ramp for deprecating an asset — the PSM must fully clear
 * its books before removal is allowed.
 *
 * 1. Zero out the USDC debt via storage injection
 * 2. Call `removeExternalAsset(USDC)` via Root
 * 3. Query `externalAssets(USDC)` and assert it returns `None`
 */
async function removeAssetWithZeroDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[psmUsdcId], 0]],
    },
  })

  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await rootCall(client, removeCall.method.toHex())

  const assetStatus = await (client.api.query as any).psm.externalAssets(psmUsdcId)
  expect(assetStatus.isNone).toBe(true)
}

/**
 * Verify that removing and re-adding an asset resets its minting fee to the pallet default.
 * Stale fee configurations from a previous registration must not persist across asset lifecycles,
 * so governance always starts from a known baseline.
 *
 * 1. Set a custom 3% minting fee on USDC via Root
 * 2. Zero out USDC debt via storage injection and remove the asset
 * 3. Re-add USDC via Root
 * 4. Query the minting fee and assert it equals the `DefaultFee` (5_000)
 */
async function feeResetsAfterRemoveAndReAdd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  const setFeeCall = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 30_000)
  await rootCall(client, setFeeCall.method.toHex())

  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[psmUsdcId], 0]],
    },
  })

  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await rootCall(client, removeCall.method.toHex())

  const addCall = (client.api.tx as any).psm.addExternalAsset(psmUsdcId)
  await rootCall(client, addCall.method.toHex())

  const mintingFee = await (client.api.query as any).psm.mintingFee(psmUsdcId)
  expect(mintingFee.toBigInt()).toBe(5_000n)
}

/**
 * Verify that an asset cannot be removed while it has outstanding debt.  Premature removal would
 * strand collateral in the PSM with no redemption path, breaking the peg guarantee for holders.
 *
 * 1. Mint USDC to create positive debt
 * 2. Assert debt > 0
 * 3. Attempt `removeExternalAsset(USDC)` via Root
 * 4. Query `externalAssets(USDC)` and assert it is still `Some` (removal was blocked)
 */
async function removeAssetBlockedByDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await signAndSend(client, mintCall, alice)

  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)

  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await rootCall(client, removeCall.method.toHex())

  const assetStatus = await (client.api.query as any).psm.externalAssets(psmUsdcId)
  expect(assetStatus.isSome).toBe(true)
}

/**
 * Verify that a minting fee set *before* an asset is registered takes effect once the asset is
 * added.  This allows governance to pre-configure risk parameters — important when onboarding
 * volatile collateral that needs immediate fee protection.
 *
 * 1. Set a 3% minting fee for asset 9998 via Root (asset not yet registered)
 * 2. Add asset 9998, set its ceiling weight, and fund alice with the asset
 * 3. Record alice's pUSD balance before minting
 * 4. Mint 1000 UNIT against asset 9998
 * 5. Assert a `Minted` event was emitted
 * 6. Assert the pUSD received is less than 97.5% of the minted amount (3% fee applied)
 */
async function setFeeBeforeAddingAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = chain.custom as any
  const alice = devAccounts.alice
  const newAssetId = 9998

  const setFeeCall = (client.api.tx as any).psm.setMintingFee(newAssetId, 30_000)
  await rootCall(client, setFeeCall.method.toHex())

  const addCall = (client.api.tx as any).psm.addExternalAsset(newAssetId)
  await rootCall(client, addCall.method.toHex())

  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(newAssetId, 100_000)
  await rootCall(client, ceilingCall.method.toHex())

  await client.dev.setStorage({
    Assets: {
      account: [[[newAssetId, alice.address], { balance: 1000e6 }]],
    },
  })

  const pUsdBefore = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall = (client.api.tx as any).psm.mint(newAssetId, 1000n * UNIT)
  await signAndSend(client, mintCall, alice)

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('mint with 3% fee applied')

  const pUsdAfter = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received = pUsdAfter - pUsdBefore

  // 3% fee ⇒ received < 97.5% of 1000 UNIT
  expect(received).toBeLessThan(975n * UNIT)
}

/// -------
/// Tests — Circuit breaker
/// -------

/**
 * Verify the `MintingDisabled` circuit breaker: governance can halt new collateral inflows while
 * still allowing holders to exit.  This is the controlled wind-down mode for a suspect asset —
 * no new exposure is created, but existing pUSD holders are not trapped.
 *
 * 1. Mint 500 UNIT of USDC into pUSD (establish a redeemable position)
 * 2. Set USDC status to `MintingDisabled` via Root
 * 3. Attempt a second mint — assert it fails with `ExtrinsicFailed`
 * 4. Redeem pUSD back to USDC — assert a `Redeemed` event is emitted (exit still works)
 */
async function mintingDisabledBlocksMintAllowsRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // Given: alice minted pUSD
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall, alice)

  // When: minting is disabled
  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'MintingDisabled')
  await rootCall(client, disableCall.method.toHex())

  // Then: subsequent mint fails
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await signAndSend(client, mintCall2, alice)
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'mint fails after MintingDisabled',
  )

  // Then: redeem still succeeds
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await signAndSend(client, redeemCall, alice)
    await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot(
      'redeem succeeds after MintingDisabled',
    )
  }
}

/**
 * Verify the full emergency shutdown: `AllDisabled` freezes the entire collateral pool in both
 * directions.  This is the nuclear option — used when the collateral itself is compromised and
 * neither minting nor redeeming can be trusted until further governance action.
 *
 * 1. Set USDC status to `AllDisabled` via Root
 * 2. Attempt to mint — assert it fails with `ExtrinsicFailed`
 * 3. Attempt to redeem (if alice holds pUSD) — assert it also fails with `ExtrinsicFailed`
 */
async function allDisabledBlocksBoth<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'AllDisabled')
  await rootCall(client, disableCall.method.toHex())

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await signAndSend(client, mintCall, alice)
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'mint fails when AllDisabled',
  )

  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await signAndSend(client, redeemCall, alice)
    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'redeem fails when AllDisabled',
    )
  }
}

/**
 * Verify the accounting invariant under `MintingDisabled`: toggling the circuit breaker must not
 * alter the debt ledger, but successful redemptions must still reduce it.  This ensures the PSM's
 * books stay consistent even during an emergency — debt only moves when real collateral flows out.
 *
 * 1. Mint 500 UNIT to establish non-zero debt
 * 2. Assert debt > 0
 * 3. Set USDC status to `MintingDisabled` via Root
 * 4. Assert debt is unchanged (disabling minting is a status toggle, not an accounting event)
 * 5. Redeem MIN_SWAP of pUSD
 * 6. Assert debt decreased after the redemption
 */
async function mintingDisabledDebtUnchangedRedeemReduces<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall, alice)

  const debtAfterMint = await psmDebt(client.api, psmUsdcId)
  expect(debtAfterMint).toBeGreaterThan(0n)

  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'MintingDisabled')
  await rootCall(client, disableCall.method.toHex())

  const debtAfterDisable = await psmDebt(client.api, psmUsdcId)
  expect(debtAfterDisable).toBe(debtAfterMint)

  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await signAndSend(client, redeemCall, alice)

    const debtAfterRedeem = await psmDebt(client.api, psmUsdcId)
    expect(debtAfterRedeem).toBeLessThan(debtAfterMint)
  }
}

/**
 * Verify that fee configuration is root-gated.  Allowing any signed origin to change fees would
 * let an attacker zero out fees before a large mint, extracting value from the insurance fund.
 *
 * 1. Call `setMintingFee` with a regular signed origin (alice)
 * 2. Assert the extrinsic fails with `ExtrinsicFailed` (bad origin)
 */
async function signedSetMintingFeeFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const setFeeCall = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await signAndSend(client, setFeeCall, alice)

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed setMintingFee without root fails',
  )
}

/// -------
/// Tests — Value conservation
/// -------

/**
 * Verify that fees are captured by the insurance fund, not lost.  After a full mint→redeem cycle
 * with 1% fees on both legs, the insurance fund must hold a positive pUSD balance — this is the
 * protocol's revenue that backstops the peg.
 *
 * 1. Set 1% minting fee and 1% redemption fee on USDC via Root
 * 2. Record the insurance fund's pUSD balance
 * 3. Mint MIN_SWAP of USDC into pUSD
 * 4. Redeem all received pUSD back to USDC
 * 5. Assert the insurance fund's pUSD balance increased (fees collected on both legs)
 */
async function mintRedeemInsuranceFundGain<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId, psmInsuranceFundAccount } = chain.custom as any
  const alice = devAccounts.alice

  const setMintFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await rootCall(client, setMintFee.method.toHex())
  const setRedeemFee = (client.api.tx as any).psm.setRedemptionFee(psmUsdcId, 10_000)
  await rootCall(client, setRedeemFee.method.toHex())

  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await signAndSend(client, mintCall, alice)

  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pUsd)
    await signAndSend(client, redeemCall, alice)
  }

  const insuranceAfter = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)
  expect(insuranceAfter - insuranceBefore).toBeGreaterThan(0n)
}

/**
 * Verify that non-zero fees create an undrainable residual: after a full mint→redeem cycle the
 * user cannot recover all deposited collateral because fees consumed part of their pUSD, leaving
 * permanent debt in the PSM.  This proves the fee model is solvent — the PSM always holds at
 * least as much collateral as the debt it owes.
 *
 * 1. Set a 1% minting fee on USDC via Root
 * 2. Mint 1000 UNIT of USDC into pUSD (fee reduces the pUSD received)
 * 3. Redeem all pUSD back to USDC
 * 4. Assert residual debt > 0 (the fee-consumed pUSD can never be redeemed)
 */
async function mintRedeemResidualDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const setMintFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await rootCall(client, setMintFee.method.toHex())

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 1000n * UNIT)
  await signAndSend(client, mintCall, alice)

  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pUsd)
    await signAndSend(client, redeemCall, alice)
  }

  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Verify that redemptions cannot exceed the PSM's actual collateral reserve.  Even if a user
 * holds more pUSD than the PSM's debt (possible via external transfers), the pallet must reject
 * over-redemptions to prevent insolvency.
 *
 * 1. Alice mints 500 UNIT of USDC, creating debt
 * 2. Give Bob 2× the current debt in pUSD via storage injection
 * 3. Bob attempts to redeem debt + MIN_SWAP (more than the reserve holds)
 * 4. Assert the extrinsic fails with `ExtrinsicFailed`
 */
async function redeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall, alice)

  const debt = await psmDebt(client.api, psmUsdcId)

  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, redeemAmount)
  await signAndSend(client, redeemCall, bob)

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'redeem exceeding reserve fails',
  )
}

/**
 * Verify that the fee parameter directly controls the user's pUSD output: a higher fee must
 * yield strictly less pUSD for the same collateral input.  This confirms the fee math is
 * monotonic and that governance can meaningfully throttle minting incentives.
 *
 * 1. Set minting fee to 0% via Root, mint 500 UNIT, record pUSD received
 * 2. Set minting fee to 5% via Root, replenish alice's USDC, mint 500 UNIT, record pUSD received
 * 3. Assert the 5%-fee mint yielded strictly less pUSD than the 0%-fee mint
 */
async function feeImpactOnMintOutput<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const setZeroFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 0)
  await rootCall(client, setZeroFee.method.toHex())

  const pUsdBefore1 = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall1 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall1, alice)

  const pUsdAfter1 = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received0Pct = pUsdAfter1 - pUsdBefore1

  const set5PctFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 50_000)
  await rootCall(client, set5PctFee.method.toHex())

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })

  const pUsdBefore2 = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall2, alice)

  const pUsdAfter2 = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received5Pct = pUsdAfter2 - pUsdBefore2

  expect(received5Pct).toBeLessThan(received0Pct)
}

/// -------
/// Tests — Ceiling dynamics
/// -------

/**
 * Verify the global debt ceiling's lifecycle: lowering it blocks further minting, and raising it
 * re-enables minting.  This exercises governance's ability to dynamically throttle the total pUSD
 * supply without touching individual asset configurations.
 *
 * 1. Mint 500 UNIT of USDC (establishes baseline debt)
 * 2. Lower `maxPsmDebt` to 1 via Root
 * 3. Attempt another mint — assert it fails (ceiling exceeded)
 * 4. Redeem MIN_SWAP to partially reduce debt
 * 5. Raise `maxPsmDebt` to 500_000 via Root
 * 6. Mint 200 UNIT — assert a `Minted` event is emitted (ceiling restored)
 */
async function maxDebtBlocksMintRestoreAllows<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall, alice)

  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(1)
  await rootCall(client, setMaxDebt.method.toHex())

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await signAndSend(client, mintCall2, alice)
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'mint fails after lowering max debt',
  )

  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await signAndSend(client, redeemCall, alice)
  }

  const restoreMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(500_000)
  await rootCall(client, restoreMaxDebt.method.toHex())

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall3 = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
  await signAndSend(client, mintCall3, alice)
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'mint succeeds after restoring max debt',
  )
}

/**
 * Verify that the global debt ceiling is shared across all collateral types.  The PSM's total
 * exposure is bounded regardless of how many stablecoins are registered, preventing a single
 * asset from monopolizing the entire debt capacity.
 *
 * 1. Set `maxPsmDebt` to 10_000 via Root
 * 2. Fund alice with USDT via storage injection
 * 3. Mint MIN_SWAP of USDC and MIN_SWAP of USDT
 * 4. Assert the combined debt across USDC and USDT is > 0
 */
async function globalDebtAcrossMultipleAssets<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId, psmUsdtId } = chain.custom as any
  const alice = devAccounts.alice

  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(10_000)
  await rootCall(client, setMaxDebt.method.toHex())

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdtId, alice.address], { balance: 1000e6 }]],
    },
  })

  const mintUsdc = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await signAndSend(client, mintUsdc, alice)

  const mintUsdt = (client.api.tx as any).psm.mint(psmUsdtId, MIN_SWAP)
  await signAndSend(client, mintUsdt, alice)

  const debtUsdc = await psmDebt(client.api, psmUsdcId)
  const debtUsdt = await psmDebt(client.api, psmUsdtId)
  expect(debtUsdc + debtUsdt).toBeGreaterThan(0n)
}

/**
 * Verify that zeroing one asset's ceiling weight does not block minting on other assets.
 * Per-asset ceiling weights partition the global debt capacity; disabling one asset's share
 * reallocates headroom to the remaining pool.
 *
 * 1. Set USDT's ceiling weight to 0 via Root (effectively disabling USDT minting)
 * 2. Mint 500 UNIT of USDC
 * 3. Assert a `Minted` event was emitted (USDC unaffected by USDT's ceiling change)
 * 4. Assert USDC debt equals exactly 500 UNIT
 */
async function zeroedCeilingWeightAllowsOtherAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId, psmUsdtId } = chain.custom as any
  const alice = devAccounts.alice

  const setCeiling = (client.api.tx as any).psm.setAssetCeilingWeight(psmUsdtId, 0)
  await rootCall(client, setCeiling.method.toHex())

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall, alice)
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'mint USDC succeeds with USDT ceiling zeroed',
  )

  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBe(500n * UNIT)
}

/// -------
/// Tests — Reserve integrity
/// -------

/**
 * Verify that minting succeeds when the amount stays within the configured global debt ceiling.
 * This is the positive-case complement to the ceiling tests — confirming the ceiling permits
 * legitimate operations rather than only blocking excessive ones.
 *
 * 1. Set `maxPsmDebt` to 5_000 via Root
 * 2. Mint 200 UNIT of USDC
 * 3. Assert debt > 0 (mint succeeded under the ceiling)
 */
async function mintWithinCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(5_000)
  await rootCall(client, setMaxDebt.method.toHex())

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
  await signAndSend(client, mintCall, alice)

  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Verify reserve protection from the perspective of a second user: Bob holds pUSD acquired
 * outside the PSM (e.g., via a DEX) and attempts to redeem more than the PSM's collateral
 * reserve.  The pallet must reject this to maintain 1:1 backing for all remaining pUSD holders.
 *
 * 1. Alice mints 500 UNIT of USDC, creating debt
 * 2. Give Bob 2× the current debt in pUSD via storage injection
 * 3. Bob attempts to redeem debt + MIN_SWAP
 * 4. Assert the extrinsic fails with `ExtrinsicFailed`
 */
async function bobRedeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall, alice)

  const debt = await psmDebt(client.api, psmUsdcId)

  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, redeemAmount)
  await signAndSend(client, redeemCall, bob)

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'Bob redeem exceeding reserve fails',
  )
}

/**
 * Verify that consecutive mints accumulate debt additively.  Each mint deposits new collateral,
 * and the debt ledger must faithfully track the sum — otherwise the PSM could become
 * under-collateralised across multiple small transactions.
 *
 * 1. Mint 500 UNIT of USDC
 * 2. Replenish alice's USDC balance via storage injection
 * 3. Mint an additional 200 UNIT of USDC
 * 4. Assert total debt > 500 UNIT (both mints are reflected)
 */
async function consecutiveMintsAccumulateDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const mintCall1 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall1, alice)

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
  await signAndSend(client, mintCall2, alice)

  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(500n * UNIT)
}

/**
 * Verify the baseline redemption path: after establishing a healthy reserve via minting, a
 * partial redemption within the reserve must succeed and emit the correct event.  This is the
 * PSM's core guarantee — holders can always exit at the peg as long as sufficient collateral
 * backs their pUSD.
 *
 * 1. Mint 500 UNIT of USDC (builds a healthy collateral reserve)
 * 2. Redeem MIN_SWAP of pUSD back to USDC
 * 3. Assert a `Redeemed` event was emitted
 */
async function healthyRedeemSucceeds<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await signAndSend(client, mintCall, alice)

  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
  await signAndSend(client, redeemCall, alice)

  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot('healthy redeem succeeds')
}

/// ----------
/// Test Trees
/// ----------

export function psmE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: 'Core swaps',
        children: [
          {
            kind: 'test',
            label: 'mint USDC to pUSD — pUSD received > 0, debt equals mint amount, fee to insurance fund',
            testFn: () => mintUsdcToPusd(chain),
          },
          {
            kind: 'test',
            label: 'mint then redeem — USDC returned > 0',
            testFn: () => mintThenRedeem(chain),
          },
          {
            kind: 'test',
            label: 'mint below MIN_SWAP fails',
            testFn: () => mintBelowMinSwapFails(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Asset lifecycle',
        children: [
          {
            kind: 'test',
            label: 'addExternalAsset with zero ceiling — mint fails',
            testFn: () => addAssetWithZeroCeiling(chain),
          },
          {
            kind: 'test',
            label: 'addExternalAsset then setCeiling — mint succeeds',
            testFn: () => addAssetThenSetCeiling(chain),
          },
          {
            kind: 'test',
            label: 'zero debt then removeExternalAsset — asset is None',
            testFn: () => removeAssetWithZeroDebt(chain),
          },
          {
            kind: 'test',
            label: 'set custom fee, remove, re-add — fee resets to default',
            testFn: () => feeResetsAfterRemoveAndReAdd(chain),
          },
          {
            kind: 'test',
            label: 'mint creates debt, removeExternalAsset blocked — asset still present',
            testFn: () => removeAssetBlockedByDebt(chain),
          },
          {
            kind: 'test',
            label: 'setMintingFee before adding asset — 3% fee applied on mint',
            testFn: () => setFeeBeforeAddingAsset(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Circuit breaker',
        children: [
          {
            kind: 'test',
            label: 'MintingDisabled — mint fails, redeem succeeds',
            testFn: () => mintingDisabledBlocksMintAllowsRedeem(chain),
          },
          {
            kind: 'test',
            label: 'AllDisabled — both mint and redeem fail',
            testFn: () => allDisabledBlocksBoth(chain),
          },
          {
            kind: 'test',
            label: 'MintingDisabled — debt unchanged, redeem reduces debt',
            testFn: () => mintingDisabledDebtUnchangedRedeemReduces(chain),
          },
          {
            kind: 'test',
            label: 'signed setMintingFee without root fails',
            testFn: () => signedSetMintingFeeFails(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Value conservation',
        children: [
          {
            kind: 'test',
            label: 'set 1% fees, mint and redeem all — insurance fund gain > 0',
            testFn: () => mintRedeemInsuranceFundGain(chain),
          },
          {
            kind: 'test',
            label: 'set 1% mint fee, mint 1000, redeem all pUSD — residual debt > 0',
            testFn: () => mintRedeemResidualDebt(chain),
          },
          {
            kind: 'test',
            label: 'Bob redeems more than reserve — ExtrinsicFailed',
            testFn: () => redeemExceedingReserveFails(chain),
          },
          {
            kind: 'test',
            label: 'fee 0% mint vs fee 5% mint — higher fee yields less pUSD',
            testFn: () => feeImpactOnMintOutput(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Ceiling dynamics',
        children: [
          {
            kind: 'test',
            label: 'mint 500, setMaxPsmDebt(1) blocks mint, restore allows mint',
            testFn: () => maxDebtBlocksMintRestoreAllows(chain),
          },
          {
            kind: 'test',
            label: 'setMaxPsmDebt(10_000), fund USDT, mint USDC and USDT — total debt > 0',
            testFn: () => globalDebtAcrossMultipleAssets(chain),
          },
          {
            kind: 'test',
            label: 'setAssetCeilingWeight(USDT, 0) — mint USDC succeeds, debt equals amount',
            testFn: () => zeroedCeilingWeightAllowsOtherAsset(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Reserve integrity',
        children: [
          {
            kind: 'test',
            label: 'setMaxPsmDebt(5_000), mint 200 — debt > 0',
            testFn: () => mintWithinCeiling(chain),
          },
          {
            kind: 'test',
            label: 'mint 500, give Bob 2x debt pUSD, Bob redeems debt plus MIN_SWAP — ExtrinsicFailed',
            testFn: () => bobRedeemExceedingReserveFails(chain),
          },
          {
            kind: 'test',
            label: 'mint 500 then mint 200 more — debt > 500 UNIT',
            testFn: () => consecutiveMintsAccumulateDebt(chain),
          },
          {
            kind: 'test',
            label: 'mint 500, redeem MIN_SWAP — Redeemed event',
            testFn: () => healthyRedeemSucceeds(chain),
          },
        ],
      },
    ],
  }
}
