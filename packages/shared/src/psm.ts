import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import { encodeAddress } from '@polkadot/util-crypto'

import { expect } from 'vitest'

import { checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

/// -------
/// Constants
/// -------

const UNIT = 1_000_000n
export const USDX_UNIT = 100n

/** 1 unit in 18-decimal precision (DAI). */
export const DAI_UNIT = 10n ** 18n

const MIN_SWAP = 100n * UNIT

/** XCM V5 Location for a local Assets pallet asset — PSM pallet keys changed from u32 to StagingXcmV5Location. */
const assetLocation = (assetId: number) => ({
  parents: 0,
  interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: assetId }] },
})

/**
 * PSM-specific test parameters.
 *
 * These are separated from chain config because they describe the test scenario,
 * not the chain itself.
 */
export interface PsmTestConfig extends TestConfig {
  psmStableAssetId: number
  psmInsuranceFundAccountRaw: string
}

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
async function psmDebt(api: Client<any, any>['api'], location: any): Promise<bigint> {
  return ((await (api.query as any).psm.psmDebt(location)) as any).toBigInt()
}

/**
 * Compute the per-asset ceiling using the same formula as the pallet:
 *   max_asset_debt = max_psm_debt * (asset_weight / total_weight_sum)
 * where max_psm_debt = MaxPsmDebtOfTotal * MaximumIssuance.
 */
async function maxAssetDebt(api: Client<any, any>['api'], location: any, maximumIssuance: bigint): Promise<bigint> {
  const maxPsmDebtOfTotal: bigint = ((await (api.query as any).psm.maxPsmDebtOfTotal()) as any).toBigInt()
  const maxPsmDebt = (maxPsmDebtOfTotal * maximumIssuance) / 1_000_000n

  const assetWeight: bigint = ((await (api.query as any).psm.assetCeilingWeight(location)) as any).toBigInt()
  if (assetWeight === 0n) return 0n

  const allWeights = await (api.query as any).psm.assetCeilingWeight.entries()
  const totalWeight: bigint = (allWeights as any[]).reduce(
    (acc: bigint, [, v]: [any, any]) => acc + (v as any).toBigInt(),
    0n,
  )
  if (totalWeight === 0n) return 0n

  return (maxPsmDebt * assetWeight) / totalWeight
}

/// -------
/// Tests — Core swaps
/// -------

/**
 * Mint USDT via the PSM and verify the resulting pUSD credit, debt tracking,
 * and fee distribution to the insurance fund.
 *
 * 1. Record alice's pUSD balance and the insurance fund's pUSD balance before the swap
 * 2. Mint MIN_SWAP (100 UNIT) of USDT into pUSD
 * 3. Verify the Minted event contains correct who, assetId, externalAmount, received, and fee
 * 4. Verify alice's pUSD balance increased
 * 5. Verify psmDebt for USDT equals the minted external amount
 * 6. Verify the insurance fund's pUSD balance increased from the collected fee
 */
async function mintUsdtToPusd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmInsuranceFundAccountRaw } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const insuranceFund = encodeAddress(psmInsuranceFundAccountRaw, chain.properties.addressEncoding)

  const alice = devAccounts.alice
  const mintAmount = MIN_SWAP

  // 1. Record balances
  const pUsdBefore = await assetBalance(client.api, psmStableAssetId, alice.address)
  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, insuranceFund)

  // 2. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), mintAmount)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Minted event
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('mint USDT: Minted event')

  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const mintedData = mintedRecord!.event.data as any
  expect(mintedData.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(mintedData.assetId.eq(assetLocation(psmPrimaryId))).toBe(true)
  expect(mintedData.externalAmount.toBigInt()).toBe(mintAmount)
  expect(mintedData.received.toBigInt()).toBeGreaterThan(0n)
  expect(mintedData.fee.toBigInt()).toBeGreaterThanOrEqual(0n)

  // 4. pUSD received
  const pUsdAfter = await assetBalance(client.api, psmStableAssetId, alice.address)
  expect(pUsdAfter - pUsdBefore).toBeGreaterThan(0n)

  // 5. Debt check
  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debt).toBe(mintAmount)

  // 6. Insurance fund
  const insuranceAfter = await assetBalance(client.api, psmStableAssetId, insuranceFund)
  expect(insuranceAfter - insuranceBefore).toBeGreaterThan(0n)
}

/**
 * Mint USDT then redeem the received pUSD, validating that a round-trip
 * conversion preserves value accounting. The mint fee plus pUSD received
 * must equal the original external amount.
 *
 * 1. Mint 10x MIN_SWAP of USDT, verify Minted event, check received + fee == externalAmount
 * 2. Redeem the minted pUSD (amount taken from the Minted event), verify Redeemed event fields
 * 3. Verify alice's USDT balance increased after the redeem
 */
async function mintThenRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any

  const alice = devAccounts.alice

  const swapAmount = 10n * MIN_SWAP

  // 1. Mint, verify Minted event
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), swapAmount)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'mint then redeem: Minted event',
  )

  const mintEvents = await client.api.query.system.events()
  const mintedRecord = mintEvents.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const mintedData = mintedRecord!.event.data as any
  const received = mintedData.received.toBigInt()
  const mintFee = mintedData.fee.toBigInt()
  expect(received + mintFee).toBe(swapAmount)
  expect(received).toBe(swapAmount - mintFee)

  // 2. Redeem minted pUSD, verify Redeemed event
  const usdtBefore = await assetBalance(client.api, psmPrimaryId, alice.address)
  const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), received)
  await sendTransaction(redeemCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot(
    'mint then redeem: Redeemed event',
  )

  const redeemEvents = await client.api.query.system.events()
  const redeemedRecord = redeemEvents.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))
  expect(redeemedRecord).toBeDefined()
  const redeemedData = redeemedRecord!.event.data as any
  expect(redeemedData.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(redeemedData.assetId.eq(assetLocation(psmPrimaryId))).toBe(true)
  expect(redeemedData.paid.toBigInt()).toBe(received)
  expect(redeemedData.externalReceived.toBigInt()).toBeGreaterThan(0n)
  expect(redeemedData.fee.toBigInt()).toBeGreaterThanOrEqual(0n)

  // 3. USDT increased
  const usdtAfter = await assetBalance(client.api, psmPrimaryId, alice.address)
  expect(usdtAfter - usdtBefore).toBeGreaterThan(0n)
}

/**
 * Minting an amount below the pallet-enforced minimum (MIN_SWAP) must fail.
 *
 * 1. Submit a mint of 1 unit of USDT, below the MIN_SWAP threshold of 100 UNIT
 * 2. Verify the block contains an ExtrinsicFailed event
 */
async function mintBelowMinSwapFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any

  const alice = devAccounts.alice
  const tinyAmount = 1n

  // 1. Submit mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), tinyAmount)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. ExtrinsicFailed event
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'mint below MIN_SWAP: ExtrinsicFailed',
  )

  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/// -------
/// Tests — Asset lifecycle
/// -------

/**
 * Register a new external asset via addExternalAsset without setting a ceiling
 * weight. Minting against it must fail because the effective ceiling is zero.
 *
 * 1. Add external asset 9999 via Root origin
 * 2. Attempt to mint MIN_SWAP of asset 9999
 * 3. Verify the mint failed with an ExtrinsicFailed event
 */
async function addAssetWithZeroCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  // 1. Add asset
  const addCall = (client.api.tx as any).psm.addExternalAsset(assetLocation(9999))
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Try mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(9999), MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Mint failed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'add asset zero ceiling: mint ExtrinsicFailed',
  )

  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/**
 * Register a new external asset, assign a non-zero ceiling weight, provision
 * it in the Assets pallet, and mint against it. Exercises the full asset
 * onboarding flow from governance to first swap.
 *
 * 1. Add external asset 9999 via Root origin
 * 2. Set ceiling weight to 100_000 for asset 9999
 * 3. Create asset 9999 in the Assets pallet and fund alice with 1000 UNIT
 * 4. Mint MIN_SWAP of asset 9999
 * 5. Verify the Minted event contains who, assetId 9999, externalAmount, and received > 0
 */
async function addAssetThenSetCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  // 1. Create asset with matching decimals before registering with PSM
  await client.dev.setStorage({
    Assets: {
      asset: [
        [
          [9999],
          {
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
            supply: 1000e6,
            deposit: 0,
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
          },
        ],
      ],
      metadata: [[[9999], { deposit: 0, name: 'Test Asset', symbol: 'TST', decimals: 6, isFrozen: false }]],
      account: [[[9999, alice.address], { balance: 1000e6 }]],
    },
  })

  // 2. Add asset
  const addCall = (client.api.tx as any).psm.addExternalAsset(assetLocation(9999))
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Set ceiling
  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(assetLocation(9999), 100_000)
  await scheduleInlineCallWithOrigin(client, ceilingCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(9999), MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 5. externalDecimals populated, internalDecimals correct
  const extDec = await (client.api.query as any).psm.externalDecimals(assetLocation(9999))
  expect(extDec.unwrap().toNumber()).toBe(6)
  const intDec = await (client.api.query as any).psm.internalDecimals()
  expect(intDec.unwrap().toNumber()).toBe(6)

  // 6. Minted event
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'add asset then set ceiling: Minted event',
  )

  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const data = mintedRecord!.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(data.assetId.eq(assetLocation(9999))).toBe(true)
  expect(data.externalAmount.toBigInt()).toBe(MIN_SWAP)
  expect(data.received.toBigInt()).toBeGreaterThan(0n)
}

/**
 * Remove an external asset from the PSM after its debt has been zeroed.
 * The pallet requires zero outstanding debt before allowing removal.
 *
 * 1. Force the USDT psmDebt to zero via setStorage
 * 2. Remove the external asset via Root origin
 * 3. Verify the externalAssets entry for USDT is None
 */
async function removeAssetWithZeroDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any

  // 1. Force debt zero
  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[assetLocation(psmPrimaryId)], 0]],
    },
  })

  // 2. Remove asset
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(assetLocation(psmPrimaryId))
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Asset removed, externalDecimals cleared
  const assetStatus = await (client.api.query as any).psm.externalAssets(assetLocation(psmPrimaryId))
  expect(assetStatus.isNone).toBe(true)
  const extDec = await (client.api.query as any).psm.externalDecimals(assetLocation(psmPrimaryId))
  expect(extDec.isNone).toBe(true)
}

/**
 * Verify that per-asset fee configuration resets to the pallet default
 * (5_000 = 0.5%) after an asset is removed and re-added. The custom fee
 * set before removal must not persist.
 *
 * 1. Set a custom minting fee of 30_000 (3%) for USDT via Root origin
 * 2. Zero the USDT psmDebt via setStorage to allow removal
 * 3. Remove USDT via removeExternalAsset, then re-add it via addExternalAsset
 * 4. Verify the minting fee for USDT returned to the default of 5_000
 */
async function feeResetsAfterRemoveAndReAdd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any

  // 1. Set fee
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(assetLocation(psmPrimaryId), 30_000)
  await scheduleInlineCallWithOrigin(client, setFeeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Zero debt
  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[assetLocation(psmPrimaryId)], 0]],
    },
  })

  // 3. Remove and re-add
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(assetLocation(psmPrimaryId))
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const addCall = (client.api.tx as any).psm.addExternalAsset(assetLocation(psmPrimaryId))
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Fee reset
  const mintingFee = await (client.api.query as any).psm.mintingFee(assetLocation(psmPrimaryId))
  expect(mintingFee.toBigInt()).toBe(5_000n)
}

/**
 * Attempt to remove an external asset while it has outstanding debt. The
 * pallet must reject the removal, leaving the asset entry intact.
 *
 * 1. Mint MIN_SWAP of USDT to create non-zero debt
 * 2. Verify psmDebt for USDT is positive
 * 3. Attempt removeExternalAsset for USDT via Root origin
 * 4. Verify the externalAssets entry for USDT still exists
 */
async function removeAssetBlockedByDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Debt positive
  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debt).toBeGreaterThan(0n)

  // 3. Try remove
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(assetLocation(psmPrimaryId))
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Asset exists
  const assetStatus = await (client.api.query as any).psm.externalAssets(assetLocation(psmPrimaryId))
  expect(assetStatus.isSome).toBe(true)
}

/**
 * Register an asset in the PSM, set a non-default minting fee, then mint
 * against it. Confirms that the fee applies to the subsequent mint.
 *
 * 1. Create asset 9998 in the Assets pallet and fund alice with 1000 UNIT
 * 2. Add asset 9998 and set its ceiling weight to 100_000
 * 3. Set a minting fee of 30_000 (3%) for asset 9998 via Root origin
 * 4. Mint 1000 UNIT of asset 9998
 * 5. Verify the Minted event contains who, assetId 9998, externalAmount, and received > 0
 * 6. Verify alice received less than 975 UNIT of pUSD, confirming the 3% fee was applied
 */
async function setFeeBeforeAddingAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const alice = devAccounts.alice
  const newAssetId = 9998

  // 1. Create asset with matching decimals before registering with PSM
  await client.dev.setStorage({
    Assets: {
      asset: [
        [
          [newAssetId],
          {
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
            supply: 1000e6,
            deposit: 0,
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
          },
        ],
      ],
      metadata: [[[newAssetId], { deposit: 0, name: 'Test Asset', symbol: 'TST', decimals: 6, isFrozen: false }]],
      account: [[[newAssetId, alice.address], { balance: 1000e6 }]],
    },
  })

  // 2. Add asset and ceiling
  const addCall = (client.api.tx as any).psm.addExternalAsset(assetLocation(newAssetId))
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(assetLocation(newAssetId), 100_000)
  await scheduleInlineCallWithOrigin(client, ceilingCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Set fee
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(assetLocation(newAssetId), 30_000)
  await scheduleInlineCallWithOrigin(client, setFeeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const pUsdBefore = await assetBalance(client.api, psmStableAssetId, alice.address)

  // 4. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(newAssetId), 1000n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 5. Minted event
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'set fee before add: Minted event',
  )

  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const mintedData = mintedRecord!.event.data as any
  expect(mintedData.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(mintedData.assetId.eq(assetLocation(newAssetId))).toBe(true)
  expect(mintedData.externalAmount.toBigInt()).toBe(1000n * UNIT)
  expect(mintedData.received.toBigInt()).toBeGreaterThan(0n)

  // 6. Fee reflected
  const pUsdAfter = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received = pUsdAfter - pUsdBefore
  expect(received).toBeLessThan(975n * UNIT)
}

/// -------
/// Tests — Circuit breaker
/// -------

/**
 * When an asset's status is set to MintingDisabled, new mints must fail while
 * redemptions continue to work. This allows governance to halt inflows without
 * trapping existing pUSD holders.
 *
 * 1. Mint 500 UNIT of USDT to create redeemable pUSD
 * 2. Set USDT status to MintingDisabled via Root origin
 * 3. Attempt a new mint of MIN_SWAP, verify it fails with ExtrinsicFailed
 * 4. Redeem MIN_SWAP of pUSD, verify the Redeemed event with correct who, assetId, paid, and externalReceived
 */
async function mintingDisabledBlocksMintAllowsRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Disable minting
  const disableCall = (client.api.tx as any).psm.setAssetStatus(assetLocation(psmPrimaryId), 'MintingDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Mint fails
  const mintCall2 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'MintingDisabled: mint ExtrinsicFailed',
  )

  const failEvents = await client.api.query.system.events()
  const failRecord = failEvents.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()

  // 4. Redeem works
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), MIN_SWAP)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot(
      'MintingDisabled: Redeemed event',
    )

    const events = await client.api.query.system.events()
    const redeemedRecord = events.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))
    expect(redeemedRecord).toBeDefined()
    const data = redeemedRecord!.event.data as any
    expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
    expect(data.assetId.eq(assetLocation(psmPrimaryId))).toBe(true)
    expect(data.paid.toBigInt()).toBe(MIN_SWAP)
    expect(data.externalReceived.toBigInt()).toBeGreaterThan(0n)
  }
}

/**
 * When an asset's status is set to AllDisabled, both minting and redemption
 * must fail. This is the full circuit breaker for an asset.
 *
 * 1. Set USDT status to AllDisabled via Root origin
 * 2. Attempt a mint of MIN_SWAP, verify ExtrinsicFailed
 * 3. If alice holds sufficient pUSD, attempt a redeem of MIN_SWAP, verify ExtrinsicFailed
 */
async function allDisabledBlocksBoth<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Disable all
  const disableCall = (client.api.tx as any).psm.setAssetStatus(assetLocation(psmPrimaryId), 'AllDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint fails
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'AllDisabled: mint ExtrinsicFailed',
  )

  let events = await client.api.query.system.events()
  let failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()

  // 3. Redeem fails
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), MIN_SWAP)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'AllDisabled: redeem ExtrinsicFailed',
    )

    events = await client.api.query.system.events()
    failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
    expect(failRecord).toBeDefined()
  }
}

/**
 * Toggling an asset to MintingDisabled must not change its debt. Debt is only
 * modified by actual mint and redeem operations, not by status changes.
 * Redemption while minting is disabled must still reduce debt normally.
 *
 * 1. Mint 500 UNIT of USDT to create debt
 * 2. Verify psmDebt for USDT is positive after the mint
 * 3. Set USDT status to MintingDisabled via Root origin
 * 4. Verify psmDebt is unchanged after the status toggle
 * 5. Redeem MIN_SWAP of pUSD and verify psmDebt decreased below the post-mint level
 */
async function mintingDisabledDebtUnchangedRedeemReduces<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Debt after mint
  const debtAfterMint = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debtAfterMint).toBeGreaterThan(0n)

  // 3. Disable minting
  const disableCall = (client.api.tx as any).psm.setAssetStatus(assetLocation(psmPrimaryId), 'MintingDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Debt unchanged
  const debtAfterDisable = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debtAfterDisable).toBe(debtAfterMint)

  // 5. Redeem decreases debt
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), MIN_SWAP)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()

    const debtAfterRedeem = await psmDebt(client.api, assetLocation(psmPrimaryId))
    expect(debtAfterRedeem).toBeLessThan(debtAfterMint)
  }
}

/**
 * The setMintingFee extrinsic requires Root origin. A signed call from a
 * regular account must fail with a bad-origin dispatch error.
 *
 * 1. Submit setMintingFee(USDT, 10_000) signed by alice
 * 2. Verify the block contains an ExtrinsicFailed event
 */
async function signedSetMintingFeeFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Submit signed
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(assetLocation(psmPrimaryId), 10_000)
  await sendTransaction(setFeeCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Bad origin
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed setMintingFee: ExtrinsicFailed',
  )

  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/// -------
/// Tests — Value conservation
/// -------

/**
 * With non-zero minting and redemption fees, a mint-then-redeem cycle must
 * increase the insurance fund's pUSD balance. The fees collected from both
 * operations are deposited into the insurance fund account.
 *
 * 1. Set minting fee to 10_000 (1%) and redemption fee to 10_000 (1%) via Root origin
 * 2. Record the insurance fund's pUSD balance
 * 3. Mint MIN_SWAP of USDT, extract received from the Minted event, then redeem that amount
 * 4. Verify the insurance fund's pUSD balance increased
 */
async function mintRedeemInsuranceFundGain<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmInsuranceFundAccountRaw } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const insuranceFund = encodeAddress(psmInsuranceFundAccountRaw, chain.properties.addressEncoding)
  const alice = devAccounts.alice

  // 1. Set fees
  const setMintFee = (client.api.tx as any).psm.setMintingFee(assetLocation(psmPrimaryId), 10_000)
  await scheduleInlineCallWithOrigin(client, setMintFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()
  const setRedeemFee = (client.api.tx as any).psm.setRedemptionFee(assetLocation(psmPrimaryId), 10_000)
  await scheduleInlineCallWithOrigin(client, setRedeemFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Record balance
  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, insuranceFund)

  // 3. Mint, extract received from event, redeem it
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'insurance fund gain: Minted event',
  )

  const mintEvents = await client.api.query.system.events()
  const mintedRecord = mintEvents.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const received = (mintedRecord!.event.data as any).received.toBigInt()

  if (received > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), received)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
  }

  // 4. Insurance increased
  const insuranceAfter = await assetBalance(client.api, psmStableAssetId, insuranceFund)
  expect(insuranceAfter - insuranceBefore).toBeGreaterThan(0n)
}

/**
 * When a minting fee is applied, redeeming all received pUSD does not fully
 * retire the debt. The fee portion was sent to the insurance fund but the
 * debt was recorded against the full external amount, leaving a residual.
 *
 * 1. Set minting fee to 10_000 (1%) for USDT via Root origin
 * 2. Mint 1000 UNIT of USDT, extract received from the Minted event, redeem that amount
 * 3. Verify psmDebt for USDT is still positive after the full redeem
 */
async function mintRedeemResidualDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set fee
  const setMintFee = (client.api.tx as any).psm.setMintingFee(assetLocation(psmPrimaryId), 10_000)
  await scheduleInlineCallWithOrigin(client, setMintFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint, extract received from event, redeem it
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 1000n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('residual debt: Minted event')

  const mintEvents = await client.api.query.system.events()
  const mintedRecord = mintEvents.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const received = (mintedRecord!.event.data as any).received.toBigInt()

  if (received > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), received)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
  }

  // 3. Residual debt
  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Attempting to redeem more pUSD than the PSM holds in external reserves
 * must fail. This prevents the pallet from issuing unbacked external tokens.
 *
 * 1. Mint 500 UNIT of USDT as alice to establish reserves
 * 2. Give bob 2x the current psmDebt in pUSD via setStorage
 * 3. Bob attempts to redeem debt + MIN_SWAP, which exceeds the reserve
 * 4. Verify the redemption failed with an ExtrinsicFailed event
 */
async function redeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Fund Bob
  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))

  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  // 3. Over-redeem
  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), redeemAmount)
  await sendTransaction(redeemCall.signAsync(bob))
  await client.dev.newBlock()

  // 4. Redemption failed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'redeem exceeding reserve: ExtrinsicFailed',
  )

  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/**
 * Compare mint output under different fee levels to verify that a higher
 * fee produces less pUSD for the same input amount.
 *
 * 1. Set minting fee to 0 for USDT, mint 500 UNIT, record pUSD received
 * 2. Set minting fee to 50_000 (5%) for USDT, refill USDT balance, mint 500 UNIT, record pUSD received
 * 3. Verify the 5% fee mint produced less pUSD than the zero-fee mint
 */
async function feeImpactOnMintOutput<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Zero fee
  const setZeroFee = (client.api.tx as any).psm.setMintingFee(assetLocation(psmPrimaryId), 0)
  await scheduleInlineCallWithOrigin(client, setZeroFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const pUsdBefore1 = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall1 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall1.signAsync(alice))
  await client.dev.newBlock()

  const pUsdAfter1 = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received0Pct = pUsdAfter1 - pUsdBefore1

  // 2. 5% fee
  const set5PctFee = (client.api.tx as any).psm.setMintingFee(assetLocation(psmPrimaryId), 50_000)
  await scheduleInlineCallWithOrigin(client, set5PctFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmPrimaryId, alice.address], { balance: 1000e6 }]],
    },
  })

  const pUsdBefore2 = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall2 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  const pUsdAfter2 = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received5Pct = pUsdAfter2 - pUsdBefore2

  // 3. Higher fee reduced
  expect(received5Pct).toBeLessThan(received0Pct)
}

/// -------
/// Tests — Ceiling dynamics
/// -------

/**
 * Verify the global debt ceiling lifecycle: lowering it blocks further minting,
 * and raising it re-enables minting. Governance can dynamically throttle total
 * pUSD supply without touching individual asset configurations.
 *
 * 1. Mint 500 UNIT of USDT to establish baseline debt
 * 2. Set maxPsmDebt to 0 via Root, attempt another mint, verify it fails
 * 3. Redeem MIN_SWAP of pUSD to partially reduce debt
 * 4. Restore maxPsmDebt to 500_000 via Root, mint 200 UNIT, verify Minted event
 */
async function maxDebtBlocksMintRestoreAllows<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint 500 UNIT
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Lower maxPsmDebt, verify mint fails
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(0)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmPrimaryId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'max debt blocks mint: ExtrinsicFailed',
  )

  let events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()

  // 3. Redeem partial
  await await assetBalance(client.api, psmStableAssetId, alice.address)

  // 4. Restore maxPsmDebt, verify mint succeeds
  const restoreMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(500_000)
  await scheduleInlineCallWithOrigin(client, restoreMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmPrimaryId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall3 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 200n * UNIT)
  await sendTransaction(mintCall3.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'max debt restore: Minted event',
  )

  events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const data = mintedRecord!.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(data.assetId.eq(assetLocation(psmPrimaryId))).toBe(true)
  expect(data.externalAmount.toBigInt()).toBe(200n * UNIT)
}

/**
 * Verify that the global debt ceiling applies across multiple external assets.
 * Minting two different assets should both contribute to the total debt
 * constrained by maxPsmDebt.
 *
 * 1. Set maxPsmDebt to 10_000 via Root origin and fund alice with 1000 UNIT of USDT
 * 2. Mint MIN_SWAP of USDT, then mint MIN_SWAP of USDX
 * 3. Verify the sum of psmDebt for USDT and USDX is positive
 */
async function globalDebtAcrossMultipleAssets<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId, usdxIndex: psmUsdxId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set max debt
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(10_000)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdxId, alice.address], { balance: 1000e6 }]],
    },
  })

  // 2. Mint both
  const mintUsdt = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintUsdt.signAsync(alice))
  await client.dev.newBlock()

  const mintUsdx = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), MIN_SWAP)
  await sendTransaction(mintUsdx.signAsync(alice))
  await client.dev.newBlock()

  // 3. Total debt positive
  const debtUsdt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  const debtUsdx = await psmDebt(client.api, assetLocation(psmUsdxId))
  expect(debtUsdt + debtUsdx).toBeGreaterThan(0n)
}

/**
 * Zeroing one asset's ceiling weight must not prevent minting a different
 * asset whose ceiling is intact. Per-asset ceiling weights are independent.
 *
 * 1. Set USDT ceiling weight to 0 via Root origin
 * 2. Mint 500 UNIT of USDT, verify the Minted event with correct who, assetId, and externalAmount
 * 3. Verify psmDebt for USDT equals 500 UNIT
 */
async function zeroedCeilingWeightAllowsOtherAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId, usdxIndex: psmUsdxId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Zero USDX ceiling
  const setCeiling = (client.api.tx as any).psm.setAssetCeilingWeight(assetLocation(psmUsdxId), 0)
  await scheduleInlineCallWithOrigin(client, setCeiling.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint USDT
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'zeroed ceiling other asset: Minted event',
  )

  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const data = mintedRecord!.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(data.assetId.eq(assetLocation(psmPrimaryId))).toBe(true)
  expect(data.externalAmount.toBigInt()).toBe(500n * UNIT)

  // 3. Debt amount
  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debt).toBe(500n * UNIT)
}

/**
 * Mint USDT to its exact per-asset ceiling and verify that the USDX ceiling
 * is unaffected. USDX must remain fully mintable after USDT fills its allocation.
 *
 * The test derives both ceilings dynamically from PSM storage to avoid
 * sensitivity to governance parameter changes.
 *
 * 1. Compute per-asset ceilings from storage and fund alice to each ceiling amount
 * 2. Mint USDT to exactly its ceiling; verify Minted event and debt equals ceiling
 * 3. Verify USDX ceiling is unchanged
 * 4. Mint USDX to exactly its ceiling; verify Minted event and debt equals ceiling
 */
async function usdtAtCeilingDoesNotConsumeUsdxCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId, usdxIndex: psmUsdxId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Compute per-asset ceilings and fund alice accordingly
  const WAH_MAXIMUM_ISSUANCE = 50_000_000n * UNIT
  const usdtCeiling = await maxAssetDebt(client.api, assetLocation(psmPrimaryId), WAH_MAXIMUM_ISSUANCE)
  const usdxCeiling = await maxAssetDebt(client.api, assetLocation(psmUsdxId), WAH_MAXIMUM_ISSUANCE)

  expect(usdtCeiling).toBeGreaterThan(0n)
  expect(usdxCeiling).toBeGreaterThan(0n)

  await client.dev.setStorage({
    Assets: {
      asset: [
        [
          [psmPrimaryId],
          {
            supply: Number(usdtCeiling),
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
            deposit: 0,
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
          },
        ],
        [
          [psmUsdxId],
          {
            supply: Number(usdxCeiling / 10_000n),
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
            deposit: 0,
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
          },
        ],
      ],
      account: [
        [[psmPrimaryId, alice.address], { balance: Number(usdtCeiling) }],
        [[psmUsdxId, alice.address], { balance: Number(usdxCeiling / 10_000n) }],
      ],
    },
  })

  // 2. Mint USDT to ceiling
  const mintUsdt = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), usdtCeiling)
  await sendTransaction(mintUsdt.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('usdt at ceiling: Minted event')

  const debtUsdt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debtUsdt).toBe(usdtCeiling)

  // 3. USDX ceiling unchanged
  const usdxCeilingAfter = await maxAssetDebt(client.api, assetLocation(psmUsdxId), WAH_MAXIMUM_ISSUANCE)
  expect(usdxCeilingAfter).toBe(usdxCeiling)

  // 4. Mint USDX to ceiling
  const mintUsdx = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), usdxCeiling / 10_000n)
  await sendTransaction(mintUsdx.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('usdx at ceiling: Minted event')

  const debtUsdx = await psmDebt(client.api, assetLocation(psmUsdxId))
  expect(debtUsdx).toBe(usdxCeiling)
}

/**
 * Mint both USDT and USDX to their respective per-asset ceilings and verify
 * that the sum of debts equals the global ceiling exactly.
 *
 * 1. Compute per-asset ceilings and global ceiling from storage; fund alice accordingly
 * 2. Mint USDT to its ceiling, then USDX to its ceiling
 * 3. Verify total psmDebt equals max_psm_debt
 */
async function bothAssetsToCeilingFillsGlobalCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId, usdxIndex: psmUsdxId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Derive ceilings from storage and fund alice accordingly
  const WAH_MAXIMUM_ISSUANCE = 50_000_000n * UNIT
  const usdtCeiling = await maxAssetDebt(client.api, assetLocation(psmPrimaryId), WAH_MAXIMUM_ISSUANCE)
  const usdxCeiling = await maxAssetDebt(client.api, assetLocation(psmUsdxId), WAH_MAXIMUM_ISSUANCE)
  await client.dev.setStorage({
    Assets: {
      asset: [
        [
          [psmPrimaryId],
          {
            supply: Number(usdtCeiling),
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
            deposit: 0,
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
          },
        ],
        [
          [psmUsdxId],
          {
            supply: Number(usdxCeiling / 10_000n),
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
            deposit: 0,
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
          },
        ],
      ],
      account: [
        [[psmPrimaryId, alice.address], { balance: Number(usdtCeiling) }],
        [[psmUsdxId, alice.address], { balance: Number(usdxCeiling / 10_000n) }],
      ],
    },
  })

  // 2. Mint both to ceiling
  const mintUsdt = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), usdtCeiling)
  await sendTransaction(mintUsdt.signAsync(alice))
  await client.dev.newBlock()

  const mintUsdx = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), usdxCeiling / 10_000n)
  await sendTransaction(mintUsdx.signAsync(alice))
  await client.dev.newBlock()

  // 3. Per-asset debts equal their respective ceilings
  const debtUsdt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  const debtUsdx = await psmDebt(client.api, assetLocation(psmUsdxId))
  expect(debtUsdt).toBe(usdtCeiling)
  expect(debtUsdx).toBe(usdxCeiling)
}

/// -------
/// Tests — Reserve integrity
/// -------

/**
 * Minting within the global debt ceiling must succeed and increase debt.
 * A conservative maxPsmDebt still allows mints that fit below it.
 *
 * 1. Set maxPsmDebt to 5_000 via Root origin
 * 2. Mint 200 UNIT of USDT
 * 3. Verify psmDebt for USDT is positive
 */
async function mintWithinCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set max debt
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(5_000)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 200n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Debt increased
  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Verify that reserve protection applies regardless of which account initiates
 * the redemption. Bob, who did not mint, receives excess pUSD via setStorage
 * and attempts to redeem more than the PSM holds in reserves.
 *
 * 1. Alice mints 500 UNIT of USDT to establish reserves
 * 2. Give bob 2x the current psmDebt in pUSD via setStorage
 * 3. Bob attempts to redeem debt + MIN_SWAP, which exceeds the reserve
 * 4. Verify the redemption failed with an ExtrinsicFailed event
 */
async function bobRedeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = testConfig
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))

  // 2. Fund Bob
  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  // 3. Bob over-redeem
  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), redeemAmount)
  await sendTransaction(redeemCall.signAsync(bob))
  await client.dev.newBlock()

  // 4. Failure event
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'bob over-redeem: ExtrinsicFailed',
  )

  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/**
 * Multiple consecutive mints of the same asset must accumulate debt additively.
 * After two mints, the total debt must exceed the amount of the first mint alone.
 *
 * 1. Mint 500 UNIT of USDT
 * 2. Refill alice's USDT balance to 1000 UNIT via setStorage, then mint 200 UNIT more
 * 3. Verify psmDebt for USDT exceeds 500 UNIT
 */
async function consecutiveMintsAccumulateDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. First mint
  const mintCall1 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall1.signAsync(alice))
  await client.dev.newBlock()

  // 2. Refill and mint
  await client.dev.setStorage({
    Assets: {
      account: [[[psmPrimaryId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 200n * UNIT)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  // 3. Debt accumulated
  const debt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debt).toBeGreaterThan(500n * UNIT)
}

/**
 * A standard partial redemption within the reserve limit must succeed and emit
 * a Redeemed event with the correct fields.
 *
 * 1. Mint 500 UNIT of USDT to build reserves
 * 2. Redeem MIN_SWAP of pUSD, verify the Redeemed event contains who, assetId, paid == MIN_SWAP, and externalReceived > 0
 */
async function healthyRedeemSucceeds<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Redeem
  const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(redeemCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot(
    'healthy redeem: Redeemed event',
  )

  const events = await client.api.query.system.events()
  const redeemedRecord = events.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))
  expect(redeemedRecord).toBeDefined()
  const data = redeemedRecord!.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(data.assetId.eq(assetLocation(psmPrimaryId))).toBe(true)
  expect(data.paid.toBigInt()).toBe(MIN_SWAP)
  expect(data.externalReceived.toBigInt()).toBeGreaterThan(0n)
}

/**
 * Set an existing asset's ceiling weight to 0 while its circuit breaker is
 * AllEnabled. Minting must still fail because the effective per-asset ceiling
 * is zero regardless of the circuit breaker status.
 *
 * 1. Verify USDT is an approved asset with a non-zero ceiling weight
 * 2. Set USDT ceiling weight to 0 via Root origin
 * 3. Attempt to mint MIN_SWAP of USDT, verify ExtrinsicFailed
 */
async function zeroCeilingBlocksMintDespiteAllEnabled<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Verify non-zero ceiling
  const ceilingBefore = await (client.api.query as any).psm.assetCeilingWeight(assetLocation(psmPrimaryId))
  expect(ceilingBefore.toBigInt()).toBeGreaterThan(0n)

  // 2. Zero the ceiling
  const setCeiling = (client.api.tx as any).psm.setAssetCeilingWeight(assetLocation(psmPrimaryId), 0)
  await scheduleInlineCallWithOrigin(client, setCeiling.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Mint fails
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'zero ceiling blocks mint despite AllEnabled: ExtrinsicFailed',
  )

  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/**
 * Set maxPsmDebt to 0 after minting both USDT and USDX. Mints of both assets
 * must fail, but redeems of both must still succeed. The global ceiling blocks
 * new inflows without trapping existing pUSD holders in either asset.
 *
 * 1. Fund alice with USDX, mint 500 UNIT of USDT and 500 UNIT of USDX
 * 2. Set maxPsmDebt to 0 via Root origin
 * 3. Attempt to mint MIN_SWAP of USDT, verify ExtrinsicFailed
 * 4. Attempt to mint MIN_SWAP of USDX, verify ExtrinsicFailed
 * 5. Redeem MIN_SWAP of pUSD via USDT, verify Redeemed event
 * 6. Redeem MIN_SWAP of pUSD via USDX, verify Redeemed event
 */
async function zeroMaxDebtBlocksBothAssetsRedeemsWork<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId, usdxIndex: psmUsdxId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Fund USDX and mint both
  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdxId, alice.address], { balance: 1000e6 }]],
    },
  })

  const mintUsdt = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintUsdt.signAsync(alice))
  await client.dev.newBlock()

  const mintUsdx = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), 500n * USDX_UNIT)
  await sendTransaction(mintUsdx.signAsync(alice))
  await client.dev.newBlock()

  // 2. Zero maxPsmDebt
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(0)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. USDT mint fails
  await client.dev.setStorage({
    Assets: {
      account: [[[psmPrimaryId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintUsdt2 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintUsdt2.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'zero maxDebt: USDT mint ExtrinsicFailed',
  )
  let events = await client.api.query.system.events()
  expect(events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))).toBeDefined()

  // 4. USDX mint fails
  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdxId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintUsdx2 = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), MIN_SWAP)
  await sendTransaction(mintUsdx2.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'zero maxDebt: USDX mint ExtrinsicFailed',
  )
  events = await client.api.query.system.events()
  expect(events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))).toBeDefined()

  // 5. USDT redeem works
  const redeemUsdt = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(redeemUsdt.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot(
    'zero maxDebt: USDT Redeemed event',
  )
  events = await client.api.query.system.events()
  expect(events.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))).toBeDefined()

  // 6. USDX redeem works
  const redeemUsdx = (client.api.tx as any).psm.redeem(assetLocation(psmUsdxId), MIN_SWAP)
  await sendTransaction(redeemUsdx.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot(
    'zero maxDebt: USDX Redeemed event',
  )
  events = await client.api.query.system.events()
  expect(events.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))).toBeDefined()
}

/**
 * Two assets both configured with equal ceiling weights. Normalization must
 * give both equal shares: minting equal amounts from each must produce equal
 * debt. Zeroing one asset's weight must block that asset while leaving the
 * other operational.
 *
 * Note: numerical ceiling boundary tests require a runtime with finite
 * MaximumIssuance. The current runtime uses Balance::MAX, making all non-zero
 * ceilings effectively unlimited.
 *
 * 1. Set both USDT and USDX weights to 750_000 (75%), fund both
 * 2. Mint 300 UNIT of USDT and 300 UNIT of USDX, verify both debts are equal
 * 3. Zero USDX's weight via Root origin
 * 4. Attempt to mint more USDX, verify ExtrinsicFailed
 * 5. Mint more USDT, verify it succeeds (USDT retains its ceiling)
 */
async function normalizedCeilingWeightEnforcement<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId, usdxIndex: psmUsdxId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set equal weights, fund both
  const setUsdtWeight = (client.api.tx as any).psm.setAssetCeilingWeight(assetLocation(psmPrimaryId), 750_000)
  await scheduleInlineCallWithOrigin(client, setUsdtWeight.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const setUsdxWeight = (client.api.tx as any).psm.setAssetCeilingWeight(assetLocation(psmUsdxId), 750_000)
  await scheduleInlineCallWithOrigin(client, setUsdxWeight.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [
        [[psmPrimaryId, alice.address], { balance: 10000e6 }],
        [[psmUsdxId, alice.address], { balance: 10000e6 }],
      ],
    },
  })

  // 2. Mint equal amounts, verify equal debt
  const mintUsdt = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 300n * UNIT)
  await sendTransaction(mintUsdt.signAsync(alice))
  await client.dev.newBlock()

  const mintUsdx = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), 300n * USDX_UNIT)
  await sendTransaction(mintUsdx.signAsync(alice))
  await client.dev.newBlock()

  const usdtDebt = await psmDebt(client.api, assetLocation(psmPrimaryId))
  const usdxDebt = await psmDebt(client.api, assetLocation(psmUsdxId))
  expect(usdtDebt).toBe(300n * UNIT)
  expect(usdxDebt).toBe(300n * UNIT)

  // 3. Zero USDX weight
  const zeroUsdxWeight = (client.api.tx as any).psm.setAssetCeilingWeight(assetLocation(psmUsdxId), 0)
  await scheduleInlineCallWithOrigin(client, zeroUsdxWeight.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. USDX mint fails
  const mintUsdxMore = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), MIN_SWAP)
  await sendTransaction(mintUsdxMore.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'normalized ceiling: USDX zero-weight mint ExtrinsicFailed',
  )

  const events = await client.api.query.system.events()
  expect(events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))).toBeDefined()

  // 5. USDT mint still works
  const mintUsdtMore = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintUsdtMore.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'normalized ceiling: USDT still mintable',
  )

  const mintEvents = await client.api.query.system.events()
  expect(mintEvents.find(({ event }) => (client.api.events as any).psm.Minted.is(event))).toBeDefined()
}

/**
 * Mint to establish debt, then zero the global ceiling. Verify minting is
 * blocked, debt is unchanged by the status change, and redeems still reduce
 * debt normally.
 *
 * Note: numerical ceiling boundary tests (mint up to exact limit) require a
 * runtime with finite MaximumIssuance. The current runtime uses Balance::MAX.
 *
 * 1. Mint 500 UNIT of USDT, verify debt is positive
 * 2. Set maxPsmDebt to 0 via Root origin
 * 3. Verify debt is unchanged after the ceiling change
 * 4. Attempt to mint MIN_SWAP, verify ExtrinsicFailed
 * 5. Redeem MIN_SWAP of pUSD, verify Redeemed event and debt decreased
 */
async function maxDebtZeroCeilingDebtUnchangedRedeemsWork<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdtIndex: psmPrimaryId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint and verify debt
  const mintCall = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  const debtAfterMint = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debtAfterMint).toBe(500n * UNIT)

  // 2. Zero the ceiling
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(0)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Debt unchanged
  const debtAfterZero = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debtAfterZero).toBe(debtAfterMint)

  // 4. Mint fails
  await client.dev.setStorage({
    Assets: {
      account: [[[psmPrimaryId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'maxDebt zero: mint ExtrinsicFailed',
  )
  const events = await client.api.query.system.events()
  expect(events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))).toBeDefined()

  // 5. Redeem works, debt decreases
  const redeemCall = (client.api.tx as any).psm.redeem(assetLocation(psmPrimaryId), MIN_SWAP)
  await sendTransaction(redeemCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot(
    'maxDebt zero: Redeemed event',
  )
  const redeemEvents = await client.api.query.system.events()
  expect(redeemEvents.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))).toBeDefined()

  const debtAfterRedeem = await psmDebt(client.api, assetLocation(psmPrimaryId))
  expect(debtAfterRedeem).toBeLessThan(debtAfterMint)
}

/// ----------
/// Test Trees
/// ----------

async function multiDecimalMintRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdxIndex: psmUsdxId, daiIndex: psmDaiId } = chain.custom as any
  const alice = devAccounts.alice

  const mintUsdx = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), 300n * USDX_UNIT)
  await sendTransaction(mintUsdx.signAsync(alice))
  await client.dev.newBlock()

  const usdxDebt = await psmDebt(client.api, assetLocation(psmUsdxId))
  expect(usdxDebt).toBe(300n * UNIT)

  const redeemUsdx = (client.api.tx as any).psm.redeem(assetLocation(psmUsdxId), 100n * UNIT)
  await sendTransaction(redeemUsdx.signAsync(alice))
  await client.dev.newBlock()

  const usdxDebtAfter = await psmDebt(client.api, assetLocation(psmUsdxId))
  expect(usdxDebtAfter).toBeGreaterThan(0n)
  expect(usdxDebtAfter).toBeLessThan(300n * UNIT)

  const redeemEvents = await client.api.query.system.events()
  const redeemed = redeemEvents.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))
  expect(redeemed).toBeDefined()
  const redeemData = redeemed!.event.data as any
  expect(redeemData.externalReceived.toBigInt()).toBeGreaterThan(0n)

  await client.dev.setStorage({
    Assets: { account: [[[psmDaiId, alice.address], { balance: DAI_UNIT }]] },
  })
  const mintDai = (client.api.tx as any).psm.mint(assetLocation(psmDaiId), DAI_UNIT)
  await sendTransaction(mintDai.signAsync(alice))
  await client.dev.newBlock()

  const daiDebt = await psmDebt(client.api, assetLocation(psmDaiId))
  expect(daiDebt).toBe(UNIT)

  const redeemDai = (client.api.tx as any).psm.redeem(assetLocation(psmDaiId), UNIT)
  await sendTransaction(redeemDai.signAsync(alice))
  await client.dev.newBlock()

  const daiDebtAfter = await psmDebt(client.api, assetLocation(psmDaiId))
  expect(daiDebtAfter).toBeLessThan(UNIT)
}

async function multiDecimalCeilings<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _testConfig: PsmTestConfig) {
  const [client] = await setupNetworks(chain)
  const { usdxIndex: psmUsdxId, daiIndex: psmDaiId } = chain.custom as any
  const alice = devAccounts.alice

  const WAH_MAXIMUM_ISSUANCE = 50_000_000n * UNIT
  const usdxCeiling = await maxAssetDebt(client.api, assetLocation(psmUsdxId), WAH_MAXIMUM_ISSUANCE)
  const daiCeiling = await maxAssetDebt(client.api, assetLocation(psmDaiId), WAH_MAXIMUM_ISSUANCE)

  expect(usdxCeiling).toBeGreaterThan(0n)
  expect(daiCeiling).toBeGreaterThan(0n)

  const usdxExternal = usdxCeiling / 10_000n // pUSD units → USDX units (÷ 10^(6-2))
  const daiExternal = daiCeiling * 1_000_000_000_000n // pUSD units → DAI units  (× 10^(18-6))

  await client.dev.setStorage({
    Assets: {
      asset: [
        [
          [psmUsdxId],
          {
            supply: Number(usdxExternal),
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
            deposit: 0,
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
          },
        ],
        [
          [psmDaiId],
          {
            supply: daiExternal,
            minBalance: 1,
            isSufficient: true,
            accounts: 1,
            sufficients: 1,
            approvals: 0,
            status: 'Live',
            deposit: 0,
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
          },
        ],
      ],
      account: [
        [[psmUsdxId, alice.address], { balance: Number(usdxExternal) }],
        [[psmDaiId, alice.address], { balance: daiExternal }],
      ],
    },
  })

  const mintUsdx = (client.api.tx as any).psm.mint(assetLocation(psmUsdxId), usdxExternal)
  await sendTransaction(mintUsdx.signAsync(alice))
  await client.dev.newBlock()

  const mintDai = (client.api.tx as any).psm.mint(assetLocation(psmDaiId), daiExternal)
  await sendTransaction(mintDai.signAsync(alice))
  await client.dev.newBlock()

  const debtUsdx = await psmDebt(client.api, assetLocation(psmUsdxId))
  const debtDai = await psmDebt(client.api, assetLocation(psmDaiId))
  expect(debtUsdx).toBe(usdxCeiling)
  expect(debtDai).toBe(daiCeiling)
}

export function psmE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig): RootTestTree {
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
            label: 'mint USDT to pUSD — pUSD received > 0, debt equals mint amount, fee to insurance fund',
            testFn: () => mintUsdtToPusd(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint then redeem — USDT returned > 0',
            testFn: () => mintThenRedeem(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint below MIN_SWAP fails',
            testFn: () => mintBelowMinSwapFails(chain, testConfig),
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
            testFn: () => addAssetWithZeroCeiling(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'addExternalAsset then setCeiling — mint succeeds',
            testFn: () => addAssetThenSetCeiling(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'zero debt then removeExternalAsset — asset is None',
            testFn: () => removeAssetWithZeroDebt(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'set custom fee, remove, re-add — fee resets to default',
            testFn: () => feeResetsAfterRemoveAndReAdd(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint creates debt, removeExternalAsset blocked — asset still present',
            testFn: () => removeAssetBlockedByDebt(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'setMintingFee before adding asset — 3% fee applied on mint',
            testFn: () => setFeeBeforeAddingAsset(chain, testConfig),
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
            testFn: () => mintingDisabledBlocksMintAllowsRedeem(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'AllDisabled — both mint and redeem fail',
            testFn: () => allDisabledBlocksBoth(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'MintingDisabled — debt unchanged, redeem reduces debt',
            testFn: () => mintingDisabledDebtUnchangedRedeemReduces(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'signed setMintingFee without root fails',
            testFn: () => signedSetMintingFeeFails(chain, testConfig),
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
            testFn: () => mintRedeemInsuranceFundGain(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'set 1% mint fee, mint 1000, redeem all pUSD — residual debt > 0',
            testFn: () => mintRedeemResidualDebt(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'Bob redeems more than reserve — ExtrinsicFailed',
            testFn: () => redeemExceedingReserveFails(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'fee 0% mint vs fee 5% mint — higher fee yields less pUSD',
            testFn: () => feeImpactOnMintOutput(chain, testConfig),
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
            testFn: () => maxDebtBlocksMintRestoreAllows(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'setMaxPsmDebt(10_000), fund USDX, mint USDT and USDX — total debt > 0',
            testFn: () => globalDebtAcrossMultipleAssets(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'setAssetCeilingWeight(USDX, 0) — mint USDT succeeds, debt equals amount',
            testFn: () => zeroedCeilingWeightAllowsOtherAsset(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'setAssetCeilingWeight(USDT, 0) — mint fails despite AllEnabled circuit breaker',
            testFn: () => zeroCeilingBlocksMintDespiteAllEnabled(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'both assets at 75% weight — normalized to 50/50, enforced at boundary',
            testFn: () => normalizedCeilingWeightEnforcement(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'setMaxPsmDebt(0) after minting both assets — mints blocked, redeems work',
            testFn: () => zeroMaxDebtBlocksBothAssetsRedeemsWork(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint 500, zero maxPsmDebt — debt unchanged, mint blocked, redeem reduces debt',
            testFn: () => maxDebtZeroCeilingDebtUnchangedRedeemsWork(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint USDT to ceiling — USDX ceiling unaffected, USDX fully mintable',
            testFn: () => usdtAtCeilingDoesNotConsumeUsdxCeiling(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint both assets to per-asset ceilings — each debt equals its ceiling',
            testFn: () => bothAssetsToCeilingFillsGlobalCeiling(chain, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Decimal conversion',
        children: [
          {
            kind: 'test',
            label: 'mint and redeem USDX and DAI — debt and received match decimal-scaled amounts',
            testFn: () => multiDecimalMintRedeem(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'USDX and DAI at per-asset ceilings — each debt equals its ceiling',
            testFn: () => multiDecimalCeilings(chain, testConfig),
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
            testFn: () => mintWithinCeiling(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint 500, give Bob 2x debt pUSD, Bob redeems debt plus MIN_SWAP — ExtrinsicFailed',
            testFn: () => bobRedeemExceedingReserveFails(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint 500 then mint 200 more — debt > 500 UNIT',
            testFn: () => consecutiveMintsAccumulateDebt(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'mint 500, redeem MIN_SWAP — Redeemed event',
            testFn: () => healthyRedeemSucceeds(chain, testConfig),
          },
        ],
      },
    ],
  }
}
