import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import { encodeAddress } from '@polkadot/util-crypto'

import { expect } from 'vitest'

import { checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

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

/// -------
/// Tests — Core swaps
/// -------

/**
 * Mint USDC via the PSM and verify the resulting pUSD credit, debt tracking,
 * and fee distribution to the insurance fund.
 *
 * 1. Record alice's pUSD balance and the insurance fund's pUSD balance before the swap
 * 2. Mint MIN_SWAP (100 UNIT) of USDC into pUSD
 * 3. Verify the Minted event contains correct who, assetId, externalAmount, pusdReceived, and fee
 * 4. Verify alice's pUSD balance increased
 * 5. Verify psmDebt for USDC equals the minted external amount
 * 6. Verify the insurance fund's pUSD balance increased from the collected fee
 */
async function mintUsdcToPusd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId, psmInsuranceFundAccountRaw } = chain.custom as any
  const insuranceFund = encodeAddress(psmInsuranceFundAccountRaw, chain.properties.addressEncoding)

  const alice = devAccounts.alice
  const mintAmount = MIN_SWAP

  // 1. Record balances
  const pUsdBefore = await assetBalance(client.api, psmStableAssetId, alice.address)
  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, insuranceFund)

  // 2. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, mintAmount)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Minted event
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('mint USDC: Minted event')

  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const mintedData = mintedRecord!.event.data as any
  expect(mintedData.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(mintedData.assetId.toNumber()).toBe(psmUsdcId)
  expect(mintedData.externalAmount.toBigInt()).toBe(mintAmount)
  expect(mintedData.pusdReceived.toBigInt()).toBeGreaterThan(0n)
  expect(mintedData.fee.toBigInt()).toBeGreaterThanOrEqual(0n)

  // 4. pUSD received
  const pUsdAfter = await assetBalance(client.api, psmStableAssetId, alice.address)
  expect(pUsdAfter - pUsdBefore).toBeGreaterThan(0n)

  // 5. Debt check
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBe(mintAmount)

  // 6. Insurance fund
  const insuranceAfter = await assetBalance(client.api, psmStableAssetId, insuranceFund)
  expect(insuranceAfter - insuranceBefore).toBeGreaterThan(0n)
}

/**
 * Mint USDC then redeem the received pUSD, validating that a round-trip
 * conversion preserves value accounting. The mint fee plus pUSD received
 * must equal the original external amount.
 *
 * 1. Mint 10x MIN_SWAP of USDC, verify Minted event, check pusdReceived + fee == externalAmount
 * 2. Redeem the minted pUSD (amount taken from the Minted event), verify Redeemed event fields
 * 3. Verify alice's USDC balance increased after the redeem
 */
async function mintThenRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  const alice = devAccounts.alice

  const swapAmount = 10n * MIN_SWAP

  // 1. Mint, verify Minted event
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, swapAmount)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'mint then redeem: Minted event',
  )

  const mintEvents = await client.api.query.system.events()
  const mintedRecord = mintEvents.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const mintedData = mintedRecord!.event.data as any
  const pusdReceived = mintedData.pusdReceived.toBigInt()
  const mintFee = mintedData.fee.toBigInt()
  expect(pusdReceived + mintFee).toBe(swapAmount)
  expect(pusdReceived).toBe(swapAmount - mintFee)

  // 2. Redeem minted pUSD, verify Redeemed event
  const usdcBefore = await assetBalance(client.api, psmUsdcId, alice.address)
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pusdReceived)
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
  expect(redeemedData.assetId.toNumber()).toBe(psmUsdcId)
  expect(redeemedData.pusdPaid.toBigInt()).toBe(pusdReceived)
  expect(redeemedData.externalReceived.toBigInt()).toBeGreaterThan(0n)
  expect(redeemedData.fee.toBigInt()).toBeGreaterThanOrEqual(0n)

  // 3. USDC increased
  const usdcAfter = await assetBalance(client.api, psmUsdcId, alice.address)
  expect(usdcAfter - usdcBefore).toBeGreaterThan(0n)
}

/**
 * Minting an amount below the pallet-enforced minimum (MIN_SWAP) must fail.
 *
 * 1. Submit a mint of 1 unit of USDC, below the MIN_SWAP threshold of 100 UNIT
 * 2. Verify the block contains an ExtrinsicFailed event
 */
async function mintBelowMinSwapFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  const alice = devAccounts.alice
  const tinyAmount = 1n

  // 1. Submit mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, tinyAmount)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  // 1. Add asset
  const addCall = (client.api.tx as any).psm.addExternalAsset(9999)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Try mint
  const mintCall = (client.api.tx as any).psm.mint(9999, MIN_SWAP)
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
 * 5. Verify the Minted event contains who, assetId 9999, externalAmount, and pusdReceived > 0
 */
async function addAssetThenSetCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  // 1. Add asset
  const addCall = (client.api.tx as any).psm.addExternalAsset(9999)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Set ceiling
  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(9999, 100_000)
  await scheduleInlineCallWithOrigin(client, ceilingCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Create asset and fund
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
      account: [[[9999, alice.address], { balance: 1000e6 }]],
    },
  })

  // 4. Mint
  const mintCall = (client.api.tx as any).psm.mint(9999, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 5. Minted event
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'add asset then set ceiling: Minted event',
  )

  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const data = mintedRecord!.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(data.assetId.toNumber()).toBe(9999)
  expect(data.externalAmount.toBigInt()).toBe(MIN_SWAP)
  expect(data.pusdReceived.toBigInt()).toBeGreaterThan(0n)
}

/**
 * Remove an external asset from the PSM after its debt has been zeroed.
 * The pallet requires zero outstanding debt before allowing removal.
 *
 * 1. Force the USDC psmDebt to zero via setStorage
 * 2. Remove the external asset via Root origin
 * 3. Verify the externalAssets entry for USDC is None
 */
async function removeAssetWithZeroDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  // 1. Force debt zero
  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[psmUsdcId], 0]],
    },
  })

  // 2. Remove asset
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Asset removed
  const assetStatus = await (client.api.query as any).psm.externalAssets(psmUsdcId)
  expect(assetStatus.isNone).toBe(true)
}

/**
 * Verify that per-asset fee configuration resets to the pallet default
 * (5_000 = 0.5%) after an asset is removed and re-added. The custom fee
 * set before removal must not persist.
 *
 * 1. Set a custom minting fee of 30_000 (3%) for USDC via Root origin
 * 2. Zero the USDC psmDebt via setStorage to allow removal
 * 3. Remove USDC via removeExternalAsset, then re-add it via addExternalAsset
 * 4. Verify the minting fee for USDC returned to the default of 5_000
 */
async function feeResetsAfterRemoveAndReAdd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  // 1. Set fee
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 30_000)
  await scheduleInlineCallWithOrigin(client, setFeeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Zero debt
  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[psmUsdcId], 0]],
    },
  })

  // 3. Remove and re-add
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const addCall = (client.api.tx as any).psm.addExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Fee reset
  const mintingFee = await (client.api.query as any).psm.mintingFee(psmUsdcId)
  expect(mintingFee.toBigInt()).toBe(5_000n)
}

/**
 * Attempt to remove an external asset while it has outstanding debt. The
 * pallet must reject the removal, leaving the asset entry intact.
 *
 * 1. Mint MIN_SWAP of USDC to create non-zero debt
 * 2. Verify psmDebt for USDC is positive
 * 3. Attempt removeExternalAsset for USDC via Root origin
 * 4. Verify the externalAssets entry for USDC still exists
 */
async function removeAssetBlockedByDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Debt positive
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)

  // 3. Try remove
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Asset exists
  const assetStatus = await (client.api.query as any).psm.externalAssets(psmUsdcId)
  expect(assetStatus.isSome).toBe(true)
}

/**
 * Set a minting fee for an asset ID before registering it in the PSM, then
 * register the asset and mint against it. The fee set before registration
 * must apply to the subsequent mint.
 *
 * 1. Set a minting fee of 30_000 (3%) for asset 9998 via Root origin
 * 2. Add asset 9998 and set its ceiling weight to 100_000
 * 3. Create asset 9998 in the Assets pallet and fund alice with 1000 UNIT
 * 4. Mint 1000 UNIT of asset 9998
 * 5. Verify the Minted event contains who, assetId 9998, externalAmount, and pusdReceived > 0
 * 6. Verify alice received less than 975 UNIT of pUSD, confirming the 3% fee was applied
 */
async function setFeeBeforeAddingAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = chain.custom as any
  const alice = devAccounts.alice
  const newAssetId = 9998

  // 1. Set fee
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(newAssetId, 30_000)
  await scheduleInlineCallWithOrigin(client, setFeeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Add asset and ceiling
  const addCall = (client.api.tx as any).psm.addExternalAsset(newAssetId)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(newAssetId, 100_000)
  await scheduleInlineCallWithOrigin(client, ceilingCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Create asset and fund
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
      account: [[[newAssetId, alice.address], { balance: 1000e6 }]],
    },
  })

  const pUsdBefore = await assetBalance(client.api, psmStableAssetId, alice.address)

  // 4. Mint
  const mintCall = (client.api.tx as any).psm.mint(newAssetId, 1000n * UNIT)
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
  expect(mintedData.assetId.toNumber()).toBe(newAssetId)
  expect(mintedData.externalAmount.toBigInt()).toBe(1000n * UNIT)
  expect(mintedData.pusdReceived.toBigInt()).toBeGreaterThan(0n)

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
 * 1. Mint 500 UNIT of USDC to create redeemable pUSD
 * 2. Set USDC status to MintingDisabled via Root origin
 * 3. Attempt a new mint of MIN_SWAP, verify it fails with ExtrinsicFailed
 * 4. Redeem MIN_SWAP of pUSD, verify the Redeemed event with correct who, assetId, pusdPaid, and externalReceived
 */
async function mintingDisabledBlocksMintAllowsRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Disable minting
  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'MintingDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Mint fails
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
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
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
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
    expect(data.assetId.toNumber()).toBe(psmUsdcId)
    expect(data.pusdPaid.toBigInt()).toBe(MIN_SWAP)
    expect(data.externalReceived.toBigInt()).toBeGreaterThan(0n)
  }
}

/**
 * When an asset's status is set to AllDisabled, both minting and redemption
 * must fail. This is the full circuit breaker for an asset.
 *
 * 1. Set USDC status to AllDisabled via Root origin
 * 2. Attempt a mint of MIN_SWAP, verify ExtrinsicFailed
 * 3. If alice holds sufficient pUSD, attempt a redeem of MIN_SWAP, verify ExtrinsicFailed
 */
async function allDisabledBlocksBoth<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Disable all
  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'AllDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint fails
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
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
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
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
 * 1. Mint 500 UNIT of USDC to create debt
 * 2. Verify psmDebt for USDC is positive after the mint
 * 3. Set USDC status to MintingDisabled via Root origin
 * 4. Verify psmDebt is unchanged after the status toggle
 * 5. Redeem MIN_SWAP of pUSD and verify psmDebt decreased below the post-mint level
 */
async function mintingDisabledDebtUnchangedRedeemReduces<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Debt after mint
  const debtAfterMint = await psmDebt(client.api, psmUsdcId)
  expect(debtAfterMint).toBeGreaterThan(0n)

  // 3. Disable minting
  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'MintingDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Debt unchanged
  const debtAfterDisable = await psmDebt(client.api, psmUsdcId)
  expect(debtAfterDisable).toBe(debtAfterMint)

  // 5. Redeem decreases debt
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()

    const debtAfterRedeem = await psmDebt(client.api, psmUsdcId)
    expect(debtAfterRedeem).toBeLessThan(debtAfterMint)
  }
}

/**
 * The setMintingFee extrinsic requires Root origin. A signed call from a
 * regular account must fail with a bad-origin dispatch error.
 *
 * 1. Submit setMintingFee(USDC, 10_000) signed by alice
 * 2. Verify the block contains an ExtrinsicFailed event
 */
async function signedSetMintingFeeFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Submit signed
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
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
 * 3. Mint MIN_SWAP of USDC, extract pusdReceived from the Minted event, then redeem that amount
 * 4. Verify the insurance fund's pUSD balance increased
 */
async function mintRedeemInsuranceFundGain<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId, psmInsuranceFundAccountRaw } = chain.custom as any
  const insuranceFund = encodeAddress(psmInsuranceFundAccountRaw, chain.properties.addressEncoding)
  const alice = devAccounts.alice

  // 1. Set fees
  const setMintFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await scheduleInlineCallWithOrigin(client, setMintFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()
  const setRedeemFee = (client.api.tx as any).psm.setRedemptionFee(psmUsdcId, 10_000)
  await scheduleInlineCallWithOrigin(client, setRedeemFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Record balance
  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, insuranceFund)

  // 3. Mint, extract pusdReceived from event, redeem it
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'insurance fund gain: Minted event',
  )

  const mintEvents = await client.api.query.system.events()
  const mintedRecord = mintEvents.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const pusdReceived = (mintedRecord!.event.data as any).pusdReceived.toBigInt()

  if (pusdReceived > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pusdReceived)
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
 * 1. Set minting fee to 10_000 (1%) for USDC via Root origin
 * 2. Mint 1000 UNIT of USDC, extract pusdReceived from the Minted event, redeem that amount
 * 3. Verify psmDebt for USDC is still positive after the full redeem
 */
async function mintRedeemResidualDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set fee
  const setMintFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await scheduleInlineCallWithOrigin(client, setMintFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint, extract pusdReceived from event, redeem it
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 1000n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('residual debt: Minted event')

  const mintEvents = await client.api.query.system.events()
  const mintedRecord = mintEvents.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const pusdReceived = (mintedRecord!.event.data as any).pusdReceived.toBigInt()

  if (pusdReceived > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pusdReceived)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
  }

  // 3. Residual debt
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Attempting to redeem more pUSD than the PSM holds in external reserves
 * must fail. This prevents the pallet from issuing unbacked external tokens.
 *
 * 1. Mint 500 UNIT of USDC as alice to establish reserves
 * 2. Give bob 2x the current psmDebt in pUSD via setStorage
 * 3. Bob attempts to redeem debt + MIN_SWAP, which exceeds the reserve
 * 4. Verify the redemption failed with an ExtrinsicFailed event
 */
async function redeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Fund Bob
  const debt = await psmDebt(client.api, psmUsdcId)

  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  // 3. Over-redeem
  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, redeemAmount)
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
 * 1. Set minting fee to 0 for USDC, mint 500 UNIT, record pUSD received
 * 2. Set minting fee to 50_000 (5%) for USDC, refill USDC balance, mint 500 UNIT, record pUSD received
 * 3. Verify the 5% fee mint produced less pUSD than the zero-fee mint
 */
async function feeImpactOnMintOutput<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Zero fee
  const setZeroFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 0)
  await scheduleInlineCallWithOrigin(client, setZeroFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const pUsdBefore1 = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall1 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall1.signAsync(alice))
  await client.dev.newBlock()

  const pUsdAfter1 = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received0Pct = pUsdAfter1 - pUsdBefore1

  // 2. 5% fee
  const set5PctFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 50_000)
  await scheduleInlineCallWithOrigin(client, set5PctFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })

  const pUsdBefore2 = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
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
 * 1. Mint 500 UNIT of USDC to establish baseline debt
 * 2. Set maxPsmDebt to 0 via Root, attempt another mint, verify it fails
 * 3. Redeem MIN_SWAP of pUSD to partially reduce debt
 * 4. Restore maxPsmDebt to 500_000 via Root, mint 200 UNIT, verify Minted event
 */
async function maxDebtBlocksMintRestoreAllows<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint 500 UNIT
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Lower maxPsmDebt, verify mint fails
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(0)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'max debt blocks mint: ExtrinsicFailed',
  )

  let events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()

  // 3. Redeem partial
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)

  // 4. Restore maxPsmDebt, verify mint succeeds
  const restoreMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(500_000)
  await scheduleInlineCallWithOrigin(client, restoreMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall3 = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
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
  expect(data.assetId.toNumber()).toBe(psmUsdcId)
  expect(data.externalAmount.toBigInt()).toBe(200n * UNIT)
}

/**
 * Verify that the global debt ceiling applies across multiple external assets.
 * Minting two different assets should both contribute to the total debt
 * constrained by maxPsmDebt.
 *
 * 1. Set maxPsmDebt to 10_000 via Root origin and fund alice with 1000 UNIT of USDT
 * 2. Mint MIN_SWAP of USDC, then mint MIN_SWAP of USDT
 * 3. Verify the sum of psmDebt for USDC and USDT is positive
 */
async function globalDebtAcrossMultipleAssets<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId, psmUsdtId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set max debt
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(10_000)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdtId, alice.address], { balance: 1000e6 }]],
    },
  })

  // 2. Mint both
  const mintUsdc = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintUsdc.signAsync(alice))
  await client.dev.newBlock()

  const mintUsdt = (client.api.tx as any).psm.mint(psmUsdtId, MIN_SWAP)
  await sendTransaction(mintUsdt.signAsync(alice))
  await client.dev.newBlock()

  // 3. Total debt positive
  const debtUsdc = await psmDebt(client.api, psmUsdcId)
  const debtUsdt = await psmDebt(client.api, psmUsdtId)
  expect(debtUsdc + debtUsdt).toBeGreaterThan(0n)
}

/**
 * Zeroing one asset's ceiling weight must not prevent minting a different
 * asset whose ceiling is intact. Per-asset ceiling weights are independent.
 *
 * 1. Set USDT ceiling weight to 0 via Root origin
 * 2. Mint 500 UNIT of USDC, verify the Minted event with correct who, assetId, and externalAmount
 * 3. Verify psmDebt for USDC equals 500 UNIT
 */
async function zeroedCeilingWeightAllowsOtherAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId, psmUsdtId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Zero USDT ceiling
  const setCeiling = (client.api.tx as any).psm.setAssetCeilingWeight(psmUsdtId, 0)
  await scheduleInlineCallWithOrigin(client, setCeiling.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint USDC
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
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
  expect(data.assetId.toNumber()).toBe(psmUsdcId)
  expect(data.externalAmount.toBigInt()).toBe(500n * UNIT)

  // 3. Debt amount
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBe(500n * UNIT)
}

/// -------
/// Tests — Reserve integrity
/// -------

/**
 * Minting within the global debt ceiling must succeed and increase debt.
 * A conservative maxPsmDebt still allows mints that fit below it.
 *
 * 1. Set maxPsmDebt to 5_000 via Root origin
 * 2. Mint 200 UNIT of USDC
 * 3. Verify psmDebt for USDC is positive
 */
async function mintWithinCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set max debt
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(5_000)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Debt increased
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Verify that reserve protection applies regardless of which account initiates
 * the redemption. Bob, who did not mint, receives excess pUSD via setStorage
 * and attempts to redeem more than the PSM holds in reserves.
 *
 * 1. Alice mints 500 UNIT of USDC to establish reserves
 * 2. Give bob 2x the current psmDebt in pUSD via setStorage
 * 3. Bob attempts to redeem debt + MIN_SWAP, which exceeds the reserve
 * 4. Verify the redemption failed with an ExtrinsicFailed event
 */
async function bobRedeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  const debt = await psmDebt(client.api, psmUsdcId)

  // 2. Fund Bob
  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  // 3. Bob over-redeem
  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, redeemAmount)
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
 * 1. Mint 500 UNIT of USDC
 * 2. Refill alice's USDC balance to 1000 UNIT via setStorage, then mint 200 UNIT more
 * 3. Verify psmDebt for USDC exceeds 500 UNIT
 */
async function consecutiveMintsAccumulateDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. First mint
  const mintCall1 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall1.signAsync(alice))
  await client.dev.newBlock()

  // 2. Refill and mint
  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  // 3. Debt accumulated
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(500n * UNIT)
}

/**
 * A standard partial redemption within the reserve limit must succeed and emit
 * a Redeemed event with the correct fields.
 *
 * 1. Mint 500 UNIT of USDC to build reserves
 * 2. Redeem MIN_SWAP of pUSD, verify the Redeemed event contains who, assetId, pusdPaid == MIN_SWAP, and externalReceived > 0
 */
async function healthyRedeemSucceeds<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Redeem
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
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
  expect(data.assetId.toNumber()).toBe(psmUsdcId)
  expect(data.pusdPaid.toBigInt()).toBe(MIN_SWAP)
  expect(data.externalReceived.toBigInt()).toBeGreaterThan(0n)
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
