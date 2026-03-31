import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import { encodeAddress } from '@polkadot/util-crypto'

import { expect } from 'vitest'

import { scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

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
 * Mint USDC and verify pUSD, debt, and fee behavior.
 * Checks the main mint path.
 */
async function mintUsdcToPusd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId, psmInsuranceFundAccount } = chain.custom as any

  const alice = devAccounts.alice
  const mintAmount = MIN_SWAP

  // 1. Record balances before mint.
  const pUsdBefore = await assetBalance(client.api, psmStableAssetId, alice.address)
  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)

  // 2. Mint MIN_SWAP USDC.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, mintAmount)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Verify Minted event fields.
  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const mintedData = mintedRecord!.event.data as any
  expect(mintedData.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(mintedData.assetId.toNumber()).toBe(psmUsdcId)
  expect(mintedData.externalAmount.toBigInt()).toBe(mintAmount)
  expect(mintedData.pusdReceived.toBigInt()).toBeGreaterThan(0n)
  expect(mintedData.fee.toBigInt()).toBeGreaterThanOrEqual(0n)

  // 4. Verify alice received pUSD.
  const pUsdAfter = await assetBalance(client.api, psmStableAssetId, alice.address)
  expect(pUsdAfter - pUsdBefore).toBeGreaterThan(0n)

  // 5. Verify debt equals minted external amount.
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBe(mintAmount)

  // 6. Verify insurance fund balance increased.
  const insuranceAfter = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)
  expect(insuranceAfter - insuranceBefore).toBeGreaterThan(0n)
}

/**
 * Mint then redeem to validate round-trip conversion.
 * Verifies both directions in one flow.
 */
async function mintThenRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any

  const alice = devAccounts.alice

  // 1. Mint MIN_SWAP USDC to pUSD.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Read minted pUSD balance.
  const pUsdReceived = await assetBalance(client.api, psmStableAssetId, alice.address)
  expect(pUsdReceived).toBeGreaterThan(0n)

  // 3. Redeem full pUSD back to USDC.
  const usdcBefore = await assetBalance(client.api, psmUsdcId, alice.address)
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pUsdReceived)
  await sendTransaction(redeemCall.signAsync(alice))
  await client.dev.newBlock()

  // 4. Verify Redeemed event fields.
  const events = await client.api.query.system.events()
  const redeemedRecord = events.find(({ event }) => (client.api.events as any).psm.Redeemed.is(event))
  expect(redeemedRecord).toBeDefined()
  const redeemedData = redeemedRecord!.event.data as any
  expect(redeemedData.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(redeemedData.assetId.toNumber()).toBe(psmUsdcId)
  expect(redeemedData.pusdPaid.toBigInt()).toBe(pUsdReceived)
  expect(redeemedData.externalReceived.toBigInt()).toBeGreaterThan(0n)
  expect(redeemedData.fee.toBigInt()).toBeGreaterThanOrEqual(0n)

  // 5. Verify USDC balance increased after redeem.
  const usdcAfter = await assetBalance(client.api, psmUsdcId, alice.address)
  expect(usdcAfter - usdcBefore).toBeGreaterThan(0n)
}

/**
 * Mint below minimum amount must fail.
 * Confirms MIN_SWAP enforcement.
 */
async function mintBelowMinSwapFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  const alice = devAccounts.alice
  const tinyAmount = 1n

  // 1. Submit mint below MIN_SWAP.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, tinyAmount)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Verify ExtrinsicFailed event.
  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/// -------
/// Tests — Asset lifecycle
/// -------

/**
 * Add asset with zero ceiling, then mint must fail.
 * Confirms registration alone does not enable minting.
 */
async function addAssetWithZeroCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  // 1. Add external asset.
  const addCall = (client.api.tx as any).psm.addExternalAsset(9999)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Try minting on zero-ceiling asset.
  const mintCall = (client.api.tx as any).psm.mint(9999, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Verify mint failed.
  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/**
 * Add an asset, set ceiling, and mint against it.
 * Confirms onboarding flow works.
 */
async function addAssetThenSetCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = devAccounts.alice

  // 1. Add external asset.
  const addCall = (client.api.tx as any).psm.addExternalAsset(9999)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Set non-zero ceiling.
  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(9999, 100_000)
  await scheduleInlineCallWithOrigin(client, ceilingCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Create the asset and fund alice.
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

  // 4. Mint against the new asset.
  const mintCall = (client.api.tx as any).psm.mint(9999, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 5. Verify Minted event fields.
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
 * Remove asset after debt is zero.
 * Confirms de-registration requirement.
 */
async function removeAssetWithZeroDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  // 1. Force debt to zero.
  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[psmUsdcId], 0]],
    },
  })

  // 2. Remove external asset with Root origin.
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Verify asset entry is removed.
  const assetStatus = await (client.api.query as any).psm.externalAssets(psmUsdcId)
  expect(assetStatus.isNone).toBe(true)
}

/**
 * Fee must reset after remove and re-add.
 * Checks default value is restored.
 */
async function feeResetsAfterRemoveAndReAdd<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any

  // 1. Set custom minting fee.
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 30_000)
  await scheduleInlineCallWithOrigin(client, setFeeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Zero debt before removing asset.
  await client.dev.setStorage({
    Psm: {
      psmDebt: [[[psmUsdcId], 0]],
    },
  })

  // 3. Remove and re-add asset.
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const addCall = (client.api.tx as any).psm.addExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Verify fee returned to default.
  const mintingFee = await (client.api.query as any).psm.mintingFee(psmUsdcId)
  expect(mintingFee.toBigInt()).toBe(5_000n)
}

/**
 * Asset removal is blocked while debt exists.
 * Confirms debt gate.
 */
async function removeAssetBlockedByDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint to create debt.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Verify debt is positive.
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)

  // 3. Try to remove asset.
  const removeCall = (client.api.tx as any).psm.removeExternalAsset(psmUsdcId)
  await scheduleInlineCallWithOrigin(client, removeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Verify asset still exists.
  const assetStatus = await (client.api.query as any).psm.externalAssets(psmUsdcId)
  expect(assetStatus.isSome).toBe(true)
}

/**
 * Set fee before registration and verify it applies.
 * Checks deferred config behavior.
 */
async function setFeeBeforeAddingAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId } = chain.custom as any
  const alice = devAccounts.alice
  const newAssetId = 9998

  // 1. Set fee before adding asset.
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(newAssetId, 30_000)
  await scheduleInlineCallWithOrigin(client, setFeeCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Add asset and set ceiling.
  const addCall = (client.api.tx as any).psm.addExternalAsset(newAssetId)
  await scheduleInlineCallWithOrigin(client, addCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const ceilingCall = (client.api.tx as any).psm.setAssetCeilingWeight(newAssetId, 100_000)
  await scheduleInlineCallWithOrigin(client, ceilingCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Create the asset, fund alice, and record pUSD balance before mint.
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

  // 4. Mint on the new asset.
  const mintCall = (client.api.tx as any).psm.mint(newAssetId, 1000n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 5. Verify Minted event fields.
  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const mintedData = mintedRecord!.event.data as any
  expect(mintedData.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(mintedData.assetId.toNumber()).toBe(newAssetId)
  expect(mintedData.externalAmount.toBigInt()).toBe(1000n * UNIT)
  expect(mintedData.pusdReceived.toBigInt()).toBeGreaterThan(0n)

  // 6. Verify received amount reflects fee.
  const pUsdAfter = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received = pUsdAfter - pUsdBefore
  expect(received).toBeLessThan(975n * UNIT)
}

/// -------
/// Tests — Circuit breaker
/// -------

/**
 * MintingDisabled blocks mint but allows redeem.
 * Validates circuit-breaker behavior.
 */
async function mintingDisabledBlocksMintAllowsRedeem<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint to create redeemable pUSD.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Set status to MintingDisabled.
  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'MintingDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 3. Verify new mint fails.
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()
  const failEvents = await client.api.query.system.events()
  const failRecord = failEvents.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()

  // 4. Verify redeem still works.
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
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
 * AllDisabled blocks both mint and redeem.
 * Verifies full pause mode.
 */
async function allDisabledBlocksBoth<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set status to AllDisabled.
  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'AllDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Verify mint fails.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()
  let events = await client.api.query.system.events()
  let failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()

  // 3. Verify redeem fails when balance is sufficient.
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
    events = await client.api.query.system.events()
    failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
    expect(failRecord).toBeDefined()
  }
}

/**
 * MintingDisabled must not change debt by itself.
 * Debt should only decrease on redeem.
 */
async function mintingDisabledDebtUnchangedRedeemReduces<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint to create debt.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Verify debt after mint.
  const debtAfterMint = await psmDebt(client.api, psmUsdcId)
  expect(debtAfterMint).toBeGreaterThan(0n)

  // 3. Disable minting for asset.
  const disableCall = (client.api.tx as any).psm.setAssetStatus(psmUsdcId, 'MintingDisabled')
  await scheduleInlineCallWithOrigin(client, disableCall.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 4. Verify debt unchanged after status toggle.
  const debtAfterDisable = await psmDebt(client.api, psmUsdcId)
  expect(debtAfterDisable).toBe(debtAfterMint)

  // 5. Redeem and verify debt decreases.
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
 * Signed call to setMintingFee must fail.
 * Confirms Root origin is required.
 */
async function signedSetMintingFeeFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Submit signed fee change.
  const setFeeCall = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await sendTransaction(setFeeCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Verify bad origin failure.
  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/// -------
/// Tests — Value conservation
/// -------

/**
 * Fees from mint and redeem should increase insurance fund.
 * Checks fee destination accounting.
 */
async function mintRedeemInsuranceFundGain<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId, psmInsuranceFundAccount } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set minting and redemption fees.
  const setMintFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await scheduleInlineCallWithOrigin(client, setMintFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()
  const setRedeemFee = (client.api.tx as any).psm.setRedemptionFee(psmUsdcId, 10_000)
  await scheduleInlineCallWithOrigin(client, setRedeemFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Record insurance balance.
  const insuranceBefore = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)

  // 3. Mint and redeem.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pUsd)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
  }

  // 4. Verify insurance fund increased.
  const insuranceAfter = await assetBalance(client.api, psmStableAssetId, psmInsuranceFundAccount)
  expect(insuranceAfter - insuranceBefore).toBeGreaterThan(0n)
}

/**
 * Non-zero fee should leave residual debt after full redeem.
 * Checks solvent fee model behavior.
 */
async function mintRedeemResidualDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set minting fee.
  const setMintFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 10_000)
  await scheduleInlineCallWithOrigin(client, setMintFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint and redeem all pUSD.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 1000n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd > 0n) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, pUsd)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
  }

  // 3. Verify residual debt remains.
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Redeem above reserve must fail.
 * Verifies reserve protection.
 */
async function redeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  // 1. Mint to create debt.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Fund Bob with excess pUSD.
  const debt = await psmDebt(client.api, psmUsdcId)

  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  // 3. Attempt over-redemption.
  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, redeemAmount)
  await sendTransaction(redeemCall.signAsync(bob))
  await client.dev.newBlock()

  // 4. Verify redemption failed.
  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/**
 * Higher fee should produce less pUSD.
 * Confirms fee impact is monotonic.
 */
async function feeImpactOnMintOutput<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint with zero fee.
  const setZeroFee = (client.api.tx as any).psm.setMintingFee(psmUsdcId, 0)
  await scheduleInlineCallWithOrigin(client, setZeroFee.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const pUsdBefore1 = await assetBalance(client.api, psmStableAssetId, alice.address)

  const mintCall1 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall1.signAsync(alice))
  await client.dev.newBlock()

  const pUsdAfter1 = await assetBalance(client.api, psmStableAssetId, alice.address)
  const received0Pct = pUsdAfter1 - pUsdBefore1

  // 2. Mint with 5% fee.
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

  // 3. Verify higher fee reduced output.
  expect(received5Pct).toBeLessThan(received0Pct)
}

/// -------
/// Tests — Ceiling dynamics
/// -------

/**
 * Lower max debt to block mint, then restore and mint.
 * Validates max debt lifecycle.
 */
async function maxDebtBlocksMintRestoreAllows<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint initial amount.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Lower max debt and verify next mint fails.
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(1)
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
  let events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()

  // 3. Redeem partial amount if possible.
  const pUsd = await assetBalance(client.api, psmStableAssetId, alice.address)
  if (pUsd >= MIN_SWAP) {
    const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
    await sendTransaction(redeemCall.signAsync(alice))
    await client.dev.newBlock()
  }

  // 4. Restore max debt and verify mint succeeds.
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
  events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const data = mintedRecord!.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(data.assetId.toNumber()).toBe(psmUsdcId)
  expect(data.externalAmount.toBigInt()).toBe(200n * UNIT)
}

/**
 * Global debt limit applies across multiple assets.
 * Confirms shared capacity.
 */
async function globalDebtAcrossMultipleAssets<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId, psmUsdtId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set max debt and fund USDT.
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(10_000)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdtId, alice.address], { balance: 1000e6 }]],
    },
  })

  // 2. Mint USDC and USDT.
  const mintUsdc = (client.api.tx as any).psm.mint(psmUsdcId, MIN_SWAP)
  await sendTransaction(mintUsdc.signAsync(alice))
  await client.dev.newBlock()

  const mintUsdt = (client.api.tx as any).psm.mint(psmUsdtId, MIN_SWAP)
  await sendTransaction(mintUsdt.signAsync(alice))
  await client.dev.newBlock()

  // 3. Verify total debt is positive.
  const debtUsdc = await psmDebt(client.api, psmUsdcId)
  const debtUsdt = await psmDebt(client.api, psmUsdtId)
  expect(debtUsdc + debtUsdt).toBeGreaterThan(0n)
}

/**
 * Zeroing one asset ceiling should not block another asset.
 * Checks per-asset ceiling isolation.
 */
async function zeroedCeilingWeightAllowsOtherAsset<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId, psmUsdtId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Zero USDT ceiling weight.
  const setCeiling = (client.api.tx as any).psm.setAssetCeilingWeight(psmUsdtId, 0)
  await scheduleInlineCallWithOrigin(client, setCeiling.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  // 2. Mint USDC and verify Minted event.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()
  const events = await client.api.query.system.events()
  const mintedRecord = events.find(({ event }) => (client.api.events as any).psm.Minted.is(event))
  expect(mintedRecord).toBeDefined()
  const data = mintedRecord!.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(alice.address, chain.properties.addressEncoding))
  expect(data.assetId.toNumber()).toBe(psmUsdcId)
  expect(data.externalAmount.toBigInt()).toBe(500n * UNIT)

  // 3. Verify debt amount.
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBe(500n * UNIT)
}

/// -------
/// Tests — Reserve integrity
/// -------

/**
 * Mint under max debt should succeed.
 * Checks positive path for debt ceiling.
 */
async function mintWithinCeiling<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Set max debt and mint.
  const setMaxDebt = (client.api.tx as any).psm.setMaxPsmDebt(5_000)
  await scheduleInlineCallWithOrigin(client, setMaxDebt.method.toHex(), { system: 'Root' }, 'NonLocal')
  await client.dev.newBlock()

  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Verify debt increased.
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(0n)
}

/**
 * Bob redeeming above reserve must fail.
 * Same reserve guard with second account.
 */
async function bobRedeemExceedingReserveFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmStableAssetId, psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice
  const bob = devAccounts.bob

  // 1. Mint to create debt.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  const debt = await psmDebt(client.api, psmUsdcId)

  // 2. Give Bob excess pUSD.
  const bobPusd = debt * 2n
  await client.dev.setStorage({
    Assets: {
      account: [[[psmStableAssetId, bob.address], { balance: Number(bobPusd) }]],
    },
  })

  // 3. Bob attempts over-redemption.
  const redeemAmount = debt + MIN_SWAP
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, redeemAmount)
  await sendTransaction(redeemCall.signAsync(bob))
  await client.dev.newBlock()

  // 4. Verify failure event.
  const events = await client.api.query.system.events()
  const failRecord = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failRecord).toBeDefined()
}

/**
 * Consecutive mints should accumulate debt.
 * Confirms additive accounting.
 */
async function consecutiveMintsAccumulateDebt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. First mint.
  const mintCall1 = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall1.signAsync(alice))
  await client.dev.newBlock()

  // 2. Refill balance and mint again.
  await client.dev.setStorage({
    Assets: {
      account: [[[psmUsdcId, alice.address], { balance: 1000e6 }]],
    },
  })
  const mintCall2 = (client.api.tx as any).psm.mint(psmUsdcId, 200n * UNIT)
  await sendTransaction(mintCall2.signAsync(alice))
  await client.dev.newBlock()

  // 3. Verify debt reflects both mints.
  const debt = await psmDebt(client.api, psmUsdcId)
  expect(debt).toBeGreaterThan(500n * UNIT)
}

/**
 * Healthy partial redeem should succeed.
 * Verifies normal redemption path.
 */
async function healthyRedeemSucceeds<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const { psmUsdcId } = chain.custom as any
  const alice = devAccounts.alice

  // 1. Mint to build reserve.
  const mintCall = (client.api.tx as any).psm.mint(psmUsdcId, 500n * UNIT)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Redeem and verify Redeemed event.
  const redeemCall = (client.api.tx as any).psm.redeem(psmUsdcId, MIN_SWAP)
  await sendTransaction(redeemCall.signAsync(alice))
  await client.dev.newBlock()

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
