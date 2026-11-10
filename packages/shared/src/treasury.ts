/**
 * E2E tests for `pallet-treasury` on the Asset Hubs.
 *
 * The pallet has two spending paths. `spend` stores an approved spend of any rated asset, which
 * anyone then claims with `payout` and settles with `check_status`, all inside a payout window.
 * The legacy `spend_local` queues a native proposal that the pallet's `on_initialize` hook pays at
 * the next spend period, together with bounty funding and the optional burn.
 *
 * All treasury time is in relay block numbers, since the Asset Hubs use the relay chain as the
 * pallet's block number provider. Parachain-system clears the current relay parent at the start of
 * every block, so a call the scheduler dispatches, and the treasury hook itself, see the previous
 * block's relay parent as "now", while a signed extrinsic sees the current block's. Windows are
 * built with whole-block margins and every test asserts where "now" is before the step it depends on.
 *
 * Privileged origins (Root, `Treasurer`, the Spender tracks) are obtained by writing the call into
 * the scheduler agenda for the next block. The scheduler never emits `ExtrinsicFailed`, so each
 * injected call's own `Dispatched` event is found by its agenda task and its result asserted.
 *
 * The Asset Hubs pay through `LocalPay`, which transfers inside `payout` and reports every payment
 * as successful. The `Failed` payment state, `PaymentFailed` and `Inconclusive` are therefore
 * unreachable on these runtimes.
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { EventRecord } from '@polkadot/types/interfaces'
import type { SpRuntimeDispatchError } from '@polkadot/types/lookup'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import {
  blockProviderOffset,
  checkEvents,
  checkSystemEvents,
  getBlockNumber,
  nextSchedulableBlockNum,
  scheduleCallListWithOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

/// -------
/// Constants
/// -------

/**
 * Largest call the scheduler accepts inline, in encoded bytes. A larger inline agenda entry
 * cannot be decoded and is discarded without an event, so a negative test would pass for the
 * wrong reason.
 */
const INLINE_CALL_LIMIT = 128

/**
 * Payment id `LocalPay` returns for every payout. Payments settle inside the extrinsic, so the
 * paymaster uses one constant id rather than a fresh query id per payment.
 */
const LOCAL_PAY_PAYMENT_ID = 2n ** 64n - 1n

/** Fixed-point denominator of `AssetRate` conversion rates (`FixedU128`). */
const RATE_DENOMINATOR = 10n ** 18n

/** Native balance given to every signing account, in existential deposits. */
const NATIVE_ENDOWMENT_EDS = 1_000_000n

/** Size of an ordinary test spend, in multiples of the asset's minimum balance. */
const SPEND_MIN_BALANCES = 100n

/**
 * Text of the bounty proposed in the slash test. Its length is part of the bond, so the bond is
 * computed from it rather than hard-coded.
 */
const BOUNTY_DESCRIPTION = 'Treasury E2E slash test'

/** Burn portion configured for the burn test: 1%, in parts per million. */
const BURN_PORTION_PPM = 10_000n

/// -------
/// Configuration
/// -------

/** Where a treasury asset's balances live on the chain. */
export type TreasuryAssetHolding =
  | { pallet: 'balances' }
  | { pallet: 'assets'; id: number }
  | { pallet: 'foreignAssets'; location: Record<string, any> }

/** An asset the treasury can spend, as the pallet and the chain's fungibles see it. */
export interface TreasuryAsset {
  /**
   * `VersionedLocatableAsset` passed to `spend`. `AssetRate` keys rates by this exact versioned
   * value, so a V5 kind needs a V5 rate entry.
   */
  kind: Record<string, any>
  /** Where the pot's and the beneficiary's balances of this asset are kept. */
  holding: TreasuryAssetHolding
}

/**
 * Treasury-specific test parameters.
 *
 * Each value is a runtime fact that metadata does not expose, so every network file cites where
 * it comes from.
 */
export interface TreasuryTestConfig extends TestConfig {
  /** Asset most tests spend. It must convert to native and be held by the pot. */
  primaryAsset: TreasuryAsset
  /** A non-native asset with a live `AssetRate` entry, held by the pot. */
  ratedAsset: TreasuryAsset
  /** A `VersionedLocatableAsset` with no `AssetRate` entry that the converter does not treat as native. */
  unratedAssetKind: Record<string, any>
  /** `SmallTipper` track's spend limit, in native planck. */
  smallTipperLimit: bigint
  /** Whether funds slashed by other pallets (here, a rejected bounty's bond) are paid into the pot. */
  slashesFundTreasury: boolean
}

/// -------
/// Helpers
/// -------

/** `VersionedLocatableAccount` for a local account, as `LocalPay` requires. */
function localBeneficiary(publicKey: Uint8Array) {
  return {
    V5: {
      location: { parents: 0, interior: 'Here' },
      accountId: { parents: 0, interior: { X1: [{ AccountId32: { network: null, id: publicKey } }] } },
    },
  }
}

/** The treasury pot account, in the chain's address format. */
function potAccount(client: Client<any, any>): string {
  return encodeAddress(client.api.consts.treasury.potAccount.toU8a(), client.config.properties.addressEncoding)
}

/** An address in the chain's address format, for comparing against decoded account ids. */
function chainAddress(client: Client<any, any>, address: string): string {
  return encodeAddress(address, client.config.properties.addressEncoding)
}

/** Free native balance of an account. */
async function freeBalance(client: Client<any, any>, address: string): Promise<bigint> {
  return (await client.api.query.system.account(address)).data.free.toBigInt()
}

/** Balance of a treasury asset held by an account, `0n` when the account holds none. */
async function assetBalance(client: Client<any, any>, holding: TreasuryAssetHolding, address: string): Promise<bigint> {
  if (holding.pallet === 'balances') return freeBalance(client, address)
  const entry =
    holding.pallet === 'assets'
      ? await client.api.query.assets.account(holding.id, address)
      : ((await client.api.query.foreignAssets.account(holding.location, address)) as any)
  return entry.isSome ? entry.unwrap().balance.toBigInt() : 0n
}

/** Total issuance of a treasury asset. */
async function assetSupply(client: Client<any, any>, holding: TreasuryAssetHolding): Promise<bigint> {
  if (holding.pallet === 'balances') return (await client.api.query.balances.totalIssuance()).toBigInt()
  const details =
    holding.pallet === 'assets'
      ? await client.api.query.assets.asset(holding.id)
      : ((await client.api.query.foreignAssets.asset(holding.location)) as any)
  return details.unwrap().supply.toBigInt()
}

/** Smallest balance an account may hold of a treasury asset: the existential deposit or `minBalance`. */
async function minimumBalance(client: Client<any, any>, holding: TreasuryAssetHolding): Promise<bigint> {
  if (holding.pallet === 'balances') return client.api.consts.balances.existentialDeposit.toBigInt()
  const details =
    holding.pallet === 'assets'
      ? await client.api.query.assets.asset(holding.id)
      : ((await client.api.query.foreignAssets.asset(holding.location)) as any)
  return details.unwrap().minBalance.toBigInt()
}

/**
 * Largest amount of `asset` whose native value stays within `nativeLimit`.
 *
 * The pallet converts with `AssetRate` (native = rate * amount, rounded down) unless the converter
 * treats the asset as native, in which case it converts 1:1. A native asset has no rate entry,
 * which this asserts so that a rate added later does not go unnoticed.
 */
async function maxAmountWithin(client: Client<any, any>, asset: TreasuryAsset, nativeLimit: bigint): Promise<bigint> {
  const rate = (await client.api.query.assetRate.conversionRateToNative(asset.kind as any)) as any
  if (asset.holding.pallet === 'balances') {
    expect(rate.isNone, 'native asset unexpectedly has an AssetRate entry').toBe(true)
    return nativeLimit
  }
  assert(rate.isSome, 'rated asset has no AssetRate entry')
  return (nativeLimit * RATE_DENOMINATOR) / rate.unwrap().toBigInt()
}

/** Give each account a native balance with one storage write per account. */
async function endowNative(client: Client<any, any>, addresses: string[]): Promise<void> {
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  await client.dev.setStorage({
    System: {
      account: addresses.map((address) => [[address], { providers: 1, data: { free: NATIVE_ENDOWMENT_EDS * ed } }]),
    },
  })
}

/**
 * How far the block provider moves per block built: one relay step per parachain block on the
 * Asset Hubs.
 */
function relayStep(client: Client<any, any>): number {
  const properties = client.config.properties
  return blockProviderOffset(
    properties.schedulerBlockProvider,
    'relayBlocksPerParaBlock' in properties ? properties.relayBlocksPerParaBlock : undefined,
  )
}

/**
 * Write `call` into the scheduler agenda with `origin`, for dispatch in the next block, and return
 * the agenda block it was written under. The call is task 0 of that block.
 */
async function scheduleCall(client: Client<any, any>, call: SubmittableExtrinsic<'promise'>, origin: any) {
  const provider = client.config.properties.schedulerBlockProvider
  expect(call.method.encodedLength, 'call too large to schedule inline').toBeLessThanOrEqual(INLINE_CALL_LIMIT)
  const when = await nextSchedulableBlockNum(client.api, provider)
  await scheduleInlineCallWithOrigin(client, call.method.toHex(), origin, provider)
  return when
}

/**
 * Result of the scheduler task `[when, index]` in the latest block. Other agenda entries from the
 * live chain may dispatch in the same block, so the task is matched by its key.
 */
async function dispatchedResult(client: Client<any, any>, when: number, index = 0) {
  const events = await client.api.query.system.events()
  const dispatched = events.find(
    ({ event }) =>
      client.api.events.scheduler.Dispatched.is(event) &&
      event.data.task[0].toNumber() === when &&
      event.data.task[1].toNumber() === index,
  )
  assert(dispatched, `scheduler task [${when}, ${index}] was not dispatched`)
  assert(client.api.events.scheduler.Dispatched.is(dispatched.event))
  return dispatched.event.data.result
}

/** Dispatch error of the single signed extrinsic whose events are given, asserting that it failed. */
function extrinsicError(client: Client<any, any>, events: EventRecord[]): SpRuntimeDispatchError {
  const failure = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(failure, 'expected the extrinsic to fail')
  assert(client.api.events.system.ExtrinsicFailed.is(failure.event))
  return failure.event.data.dispatchError
}

/**
 * Assert that `error` is the treasury module error `errorName`. The name is looked up in the
 * runtime's error metadata, so a renamed or removed variant fails the test instead of matching
 * nothing.
 */
function expectTreasuryError(client: Client<any, any>, error: SpRuntimeDispatchError, errorName: string): void {
  assert(error.isModule, `expected a module error, got ${error.type}`)
  const treasuryErrors = client.api.errors.treasury as Record<string, any>
  assert(treasuryErrors[errorName], `runtime has no treasury error named ${errorName}`)
  expect(treasuryErrors[errorName].is(error.asModule), `expected treasury.${errorName}`).toBe(true)
}

/** The only `AssetSpendApproved` event in the latest block, asserting there is exactly one. */
async function assetSpendApprovedEvent(client: Client<any, any>) {
  const events = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.treasury.AssetSpendApproved.is(event),
  )
  expect(events).toHaveLength(1)
  assert(client.api.events.treasury.AssetSpendApproved.is(events[0].event))
  return events[0].event.data
}

/** A `spend` of `amount` of `asset` to bob. */
function spendToBob(client: Client<any, any>, asset: TreasuryAsset, amount: bigint, validFrom: number | null = null) {
  return client.api.tx.treasury.spend(
    asset.kind as any,
    amount,
    localBeneficiary(testAccounts.bob.addressRaw) as any,
    validFrom,
  )
}

/**
 * Approve a spend of `amount` of `asset` to bob, dispatched by `origin` in one block, and return
 * its index. The spend is created by the real `spend` call; only the origin is injected.
 */
async function approveSpend(
  client: Client<any, any>,
  asset: TreasuryAsset,
  amount: bigint,
  origin: any,
  validFrom: number | null = null,
): Promise<number> {
  const index = (await client.api.query.treasury.spendCount()).toNumber()
  const when = await scheduleCall(client, spendToBob(client, asset, amount, validFrom), origin)
  await client.dev.newBlock()

  const result = await dispatchedResult(client, when)
  assert(result.isOk, `spend was not approved: ${result.isErr ? result.asErr.type : ''}`)
  expect((await assetSpendApprovedEvent(client)).index.toNumber()).toBe(index)
  return index
}

/// -------
/// Tests - Spend
/// -------

/**
 * A Spender track approves a spend, which is stored as pending with a full payout window.
 *
 * `valid_from` defaults to "now", which for a scheduler-dispatched call is the agenda block it was
 * written under (see the module docs), so the stored window is checked exactly.
 *
 * 1. Record the spend count and schedule a `spend` of the primary asset to bob as `BigSpender`
 * 2. Verify the scheduled call succeeded and the AssetSpendApproved event carries the call's values
 * 3. Verify the spend is stored as pending with `expire_at = valid_from + PayoutPeriod`
 * 4. Verify the spend count grew by one and the new spend took the old count as its index
 */
async function spendApprovedByBigSpender(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  const payoutPeriod = client.api.consts.treasury.payoutPeriod.toNumber()
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Schedule the spend
  const countBefore = (await client.api.query.treasury.spendCount()).toNumber()
  const spend = spendToBob(client, primaryAsset, amount)
  const when = await scheduleCall(client, spend, { Origins: 'BigSpender' })
  await client.dev.newBlock()

  // 2. Dispatched and approved
  const result = await dispatchedResult(client, when)
  expect(result.isOk).toBe(true)

  await checkSystemEvents(client, { section: 'treasury', method: 'AssetSpendApproved' })
    .redact({ redactKeys: /^(index|validFrom|expireAt)$/ })
    .toMatchSnapshot('spend: AssetSpendApproved event')

  const approved = await assetSpendApprovedEvent(client)
  expect(approved.index.toNumber()).toBe(countBefore)
  expect(approved.assetKind.toHex()).toBe(spend.args[0].toHex())
  expect(approved.amount.toBigInt()).toBe(amount)
  expect(approved.beneficiary.toHex()).toBe(spend.args[2].toHex())
  expect(approved.validFrom.toNumber()).toBe(when)
  expect(approved.expireAt.toNumber()).toBe(when + payoutPeriod)

  // 3. Stored as pending
  const stored = await client.api.query.treasury.spends(countBefore)
  assert(stored.isSome, 'spend not stored')
  const spendStatus = stored.unwrap()
  expect(spendStatus.assetKind.toHex()).toBe(spend.args[0].toHex())
  expect(spendStatus.amount.toBigInt()).toBe(amount)
  expect(spendStatus.beneficiary.toHex()).toBe(spend.args[2].toHex())
  expect(spendStatus.validFrom.toNumber()).toBe(when)
  expect(spendStatus.expireAt.toNumber()).toBe(when + payoutPeriod)
  expect(spendStatus.status.isPending).toBe(true)

  // 4. Count and index
  expect((await client.api.query.treasury.spendCount()).toNumber()).toBe(countBefore + 1)
}

/**
 * `SmallTipper` can approve a spend of exactly its limit.
 *
 * 1. Compute the largest primary-asset amount within the track's native limit
 * 2. Approve a spend of that amount as `SmallTipper`
 * 3. Verify the stored amount is the limit amount
 */
async function spendAtSmallTipperLimit(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset, smallTipperLimit } = testConfig

  // 1. Limit in the primary asset
  const atLimit = await maxAmountWithin(client, primaryAsset, smallTipperLimit)

  // 2. Approve
  const index = await approveSpend(client, primaryAsset, atLimit, { Origins: 'SmallTipper' })

  // 3. Stored amount
  expect((await client.api.query.treasury.spends(index)).unwrap().amount.toBigInt()).toBe(atLimit)
}

/**
 * `SmallTipper` cannot approve a spend one unit above its limit.
 *
 * 1. Compute the largest primary-asset amount within the limit, and record the spend count
 * 2. Schedule a spend of one unit more as `SmallTipper`
 * 3. Verify the call failed with InsufficientPermission and no spend was stored
 */
async function spendOverSmallTipperLimitFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset, smallTipperLimit } = testConfig

  // 1. Limit and count
  const atLimit = await maxAmountWithin(client, primaryAsset, smallTipperLimit)
  const countBefore = (await client.api.query.treasury.spendCount()).toNumber()

  // 2. One unit over
  const when = await scheduleCall(client, spendToBob(client, primaryAsset, atLimit + 1n), { Origins: 'SmallTipper' })
  await client.dev.newBlock()

  // 3. Rejected, nothing stored
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'spend over the limit was approved')
  expectTreasuryError(client, result.asErr, 'InsufficientPermission')
  expect((await client.api.query.treasury.spendCount()).toNumber()).toBe(countBefore)
}

/**
 * A rated asset's spend limit applies to its native value after `AssetRate` conversion, not to its
 * raw amount.
 *
 * 1. Compute the largest rated-asset amount whose converted value is within the `SmallTipper` limit
 * 2. Approve a spend of that amount as `SmallTipper`
 * 3. Verify the stored amount is the converted limit
 */
async function ratedSpendAtConvertedLimit(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { ratedAsset, smallTipperLimit } = testConfig

  // 1. Converted limit
  const atLimit = await maxAmountWithin(client, ratedAsset, smallTipperLimit)
  expect(atLimit).not.toBe(smallTipperLimit)

  // 2. Approve
  const index = await approveSpend(client, ratedAsset, atLimit, { Origins: 'SmallTipper' })

  // 3. Stored amount
  expect((await client.api.query.treasury.spends(index)).unwrap().amount.toBigInt()).toBe(atLimit)
}

/**
 * One unit of a rated asset above its converted limit is refused.
 *
 * 1. Compute the converted limit and record the spend count
 * 2. Schedule a spend of one unit more as `SmallTipper`
 * 3. Verify the call failed with InsufficientPermission and no spend was stored
 */
async function ratedSpendOverConvertedLimitFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { ratedAsset, smallTipperLimit } = testConfig

  // 1. Converted limit and count
  const atLimit = await maxAmountWithin(client, ratedAsset, smallTipperLimit)
  const countBefore = (await client.api.query.treasury.spendCount()).toNumber()

  // 2. One unit over
  const when = await scheduleCall(client, spendToBob(client, ratedAsset, atLimit + 1n), { Origins: 'SmallTipper' })
  await client.dev.newBlock()

  // 3. Rejected, nothing stored
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'rated spend over the converted limit was approved')
  expectTreasuryError(client, result.asErr, 'InsufficientPermission')
  expect((await client.api.query.treasury.spendCount()).toNumber()).toBe(countBefore)
}

/**
 * A Spender track's limit caps the sum of its spends within one dispatch, so a batch cannot split
 * an oversized spend into allowed halves.
 *
 * The pallet keys the running total by the origin's limit inside the dispatch context, which a
 * `batch_all` shares with the calls it wraps.
 *
 * 1. Split one unit more than the `SmallTipper` limit into two spends, each within the limit alone
 * 2. Schedule a `batch_all` of both as `SmallTipper`
 * 3. Verify the batch failed with InsufficientPermission and no spend was stored
 */
async function batchedSpendsOverLimitFail(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset, smallTipperLimit } = testConfig

  // 1. Two halves of limit + 1
  const atLimit = await maxAmountWithin(client, primaryAsset, smallTipperLimit)
  const firstHalf = atLimit / 2n + 1n
  const secondHalf = atLimit + 1n - firstHalf
  expect(firstHalf).toBeLessThanOrEqual(atLimit)
  expect(secondHalf).toBeLessThanOrEqual(atLimit)
  const batch = client.api.tx.utility.batchAll([
    spendToBob(client, primaryAsset, firstHalf),
    spendToBob(client, primaryAsset, secondHalf),
  ])

  // 2. Schedule the batch
  const countBefore = (await client.api.query.treasury.spendCount()).toNumber()
  const when = await scheduleCall(client, batch, { Origins: 'SmallTipper' })
  await client.dev.newBlock()

  // 3. Rejected as a whole
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'batched spends over the limit were approved')
  expectTreasuryError(client, result.asErr, 'InsufficientPermission')
  expect((await client.api.query.treasury.spendCount()).toNumber()).toBe(countBefore)
}

/**
 * A signed account cannot approve a spend.
 *
 * 1. Record the spend count and submit `spend` signed by alice
 * 2. Verify the extrinsic failed with BadOrigin and no spend was stored
 */
async function spendFromSignedOriginFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Signed spend
  const countBefore = (await client.api.query.treasury.spendCount()).toNumber()
  const tx = await sendTransaction(spendToBob(client, primaryAsset, amount).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // 2. Rejected
  expect(extrinsicError(client, (await tx.events) as EventRecord[]).isBadOrigin).toBe(true)
  expect((await client.api.query.treasury.spendCount()).toNumber()).toBe(countBefore)
}

/**
 * A spend of an asset the converter cannot value is refused before any limit check.
 *
 * 1. Verify the unrated kind has no `AssetRate` entry
 * 2. Schedule a spend of it as `BigSpender`
 * 3. Verify the call failed with FailedToConvertBalance and no spend was stored
 */
async function spendUnratedAssetFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { unratedAssetKind } = testConfig

  // 1. Precondition: no rate
  const rate = (await client.api.query.assetRate.conversionRateToNative(unratedAssetKind as any)) as any
  expect(rate.isNone).toBe(true)
  const countBefore = (await client.api.query.treasury.spendCount()).toNumber()

  // 2. Spend
  const unrated = { kind: unratedAssetKind, holding: { pallet: 'balances' } } as const
  const when = await scheduleCall(client, spendToBob(client, unrated, 1_000_000n), { Origins: 'BigSpender' })
  await client.dev.newBlock()

  // 3. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'spend of an unrated asset was approved')
  expectTreasuryError(client, result.asErr, 'FailedToConvertBalance')
  expect((await client.api.query.treasury.spendCount()).toNumber()).toBe(countBefore)
}

/**
 * A spend whose payout window has already closed is refused at approval.
 *
 * With `valid_from = now - PayoutPeriod`, the window ends exactly at "now", and the pallet requires
 * it to end strictly after.
 *
 * 1. Schedule a spend with `valid_from` one payout period before the dispatch block
 * 2. Verify the call failed with SpendExpired and no spend was stored
 */
async function spendAlreadyExpiredFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  const payoutPeriod = client.api.consts.treasury.payoutPeriod.toNumber()
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))
  const countBefore = (await client.api.query.treasury.spendCount()).toNumber()

  // 1. Window ends at the dispatch block
  const now = await nextSchedulableBlockNum(client.api, client.config.properties.schedulerBlockProvider)
  const when = await scheduleCall(client, spendToBob(client, primaryAsset, amount, now - payoutPeriod), {
    Origins: 'BigSpender',
  })
  expect(when).toBe(now)
  await client.dev.newBlock()

  // 2. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'expired spend was approved')
  expectTreasuryError(client, result.asErr, 'SpendExpired')
  expect((await client.api.query.treasury.spendCount()).toNumber()).toBe(countBefore)
}

/**
 * `valid_from` may lie in the past while the window is still open; the spend is then claimable at
 * once and keeps the past `valid_from`.
 *
 * 1. Approve a spend with `valid_from` half a payout period before now
 * 2. Verify the stored window starts at that past block
 * 3. Pay it out straight away, and verify the Paid event
 */
async function spendWithPastValidFromIsClaimable(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const payoutPeriod = client.api.consts.treasury.payoutPeriod.toNumber()
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Past valid_from
  const now = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const validFrom = now - Math.floor(payoutPeriod / 2)
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' }, validFrom)

  // 2. Window
  const stored = (await client.api.query.treasury.spends(index)).unwrap()
  expect(stored.validFrom.toNumber()).toBe(validFrom)
  expect(stored.expireAt.toNumber()).toBe(validFrom + payoutPeriod)

  // 3. Claimable now
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  const paid = ((await tx.events) as EventRecord[]).find(({ event }) => client.api.events.treasury.Paid.is(event))
  assert(paid, 'payout of a spend with a past valid_from did not succeed')
  assert(client.api.events.treasury.Paid.is(paid.event))
  expect(paid.event.data.index.toNumber()).toBe(index)
}

/// -------
/// Tests - Payout
/// -------

/**
 * Any signed account can pay out a pending spend; the funds go to the spend's beneficiary.
 *
 * Alice signs and bob is the beneficiary, so the fee does not touch the balances under test.
 *
 * 1. Approve a spend of the primary asset to bob, and record bob's and the pot's balances
 * 2. Pay it out signed by alice, and verify the Paid event carries the index and `LocalPay`'s id
 * 3. Verify bob received exactly the amount and the pot paid exactly the amount
 * 4. Verify the spend is now Attempted and its window restarted from the payout block
 */
async function payoutPaysBeneficiary(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const payoutPeriod = client.api.consts.treasury.payoutPeriod.toNumber()
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))
  const pot = potAccount(client)

  // 1. Approve and record balances
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })
  const bobBefore = await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)
  const potBefore = await assetBalance(client, primaryAsset.holding, pot)

  // 2. Payout
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  await checkEvents(tx, { section: 'treasury', method: 'Paid' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('payout: Paid event')

  const paid = ((await tx.events) as EventRecord[]).find(({ event }) => client.api.events.treasury.Paid.is(event))
  assert(paid, 'payout did not succeed')
  assert(client.api.events.treasury.Paid.is(paid.event))
  expect(paid.event.data.index.toNumber()).toBe(index)
  expect(BigInt(paid.event.data.paymentId.toString())).toBe(LOCAL_PAY_PAYMENT_ID)

  // 3. Balances
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobBefore + amount)
  expect(await assetBalance(client, primaryAsset.holding, pot)).toBe(potBefore - amount)

  // 4. Attempted, window restarted at the payout block's relay parent
  const payoutNow = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const stored = (await client.api.query.treasury.spends(index)).unwrap()
  assert(stored.status.isAttempted, `expected Attempted, got ${stored.status.type}`)
  expect(BigInt(stored.status.asAttempted.id.toString())).toBe(LOCAL_PAY_PAYMENT_ID)
  expect(stored.expireAt.toNumber()).toBe(payoutNow + payoutPeriod)
}

/**
 * Paying out a rated non-native asset moves it from the pot to the beneficiary without changing
 * the asset's total issuance.
 *
 * 1. Approve a spend of the rated asset to bob, and record both balances and the supply
 * 2. Pay it out, and verify the Paid event
 * 3. Verify bob received and the pot paid exactly the amount, and the supply is unchanged
 */
async function ratedPayoutPreservesSupply(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { ratedAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, ratedAsset.holding))
  const pot = potAccount(client)

  // 1. Approve and record
  const index = await approveSpend(client, ratedAsset, amount, { Origins: 'BigSpender' })
  const bobBefore = await assetBalance(client, ratedAsset.holding, testAccounts.bob.address)
  const potBefore = await assetBalance(client, ratedAsset.holding, pot)
  const supplyBefore = await assetSupply(client, ratedAsset.holding)
  expect(potBefore).toBeGreaterThanOrEqual(amount)

  // 2. Payout
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  await checkEvents(tx, { section: 'treasury', method: 'Paid' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('rated payout: Paid event')

  const paid = ((await tx.events) as EventRecord[]).find(({ event }) => client.api.events.treasury.Paid.is(event))
  assert(paid, 'rated payout did not succeed')
  assert(client.api.events.treasury.Paid.is(paid.event))
  expect(paid.event.data.index.toNumber()).toBe(index)

  // 3. Balances and supply
  expect(await assetBalance(client, ratedAsset.holding, testAccounts.bob.address)).toBe(bobBefore + amount)
  expect(await assetBalance(client, ratedAsset.holding, pot)).toBe(potBefore - amount)
  expect(await assetSupply(client, ratedAsset.holding)).toBe(supplyBefore)
}

/**
 * A spend with a future `valid_from` cannot be paid out until the relay chain reaches that block,
 * and can be once it does.
 *
 * The spend dispatches with "now" at the agenda block, and each block moves the relay parent by the
 * provider offset, so `valid_from` three offsets ahead leaves the next block early.
 *
 * 1. Approve a spend with `valid_from` three relay offsets after the agenda block
 * 2. Pay out in the next block, and verify it failed with EarlyPayout and changed nothing
 * 3. Build blocks until the payout block's relay parent reaches `valid_from`
 * 4. Pay out again, and verify the Paid event and bob's balance
 */
async function earlyPayoutFailsUntilValidFrom(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const provider = client.config.properties.schedulerBlockProvider
  const offset = relayStep(client)
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Future valid_from
  const scheduledAt = await getBlockNumber(client.api, provider)
  const validFrom = scheduledAt + 3 * offset
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' }, validFrom)
  const afterApproval = await getBlockNumber(client.api, provider)
  expect(afterApproval - scheduledAt, 'relay parent moved by an unexpected step').toBe(offset)

  // 2. Too early
  const bobBefore = await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)
  expect(afterApproval + offset).toBeLessThan(validFrom)
  const early = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  expectTreasuryError(client, extrinsicError(client, (await early.events) as EventRecord[]), 'EarlyPayout')
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isPending).toBe(true)
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobBefore)

  // 3. Advance until the next block's relay parent is at least valid_from
  const current = await getBlockNumber(client.api, provider)
  const blocksToOpen = Math.ceil((validFrom - current) / offset) - 1
  if (blocksToOpen > 0) await client.dev.newBlock({ count: blocksToOpen })
  expect((await getBlockNumber(client.api, provider)) + offset).toBeGreaterThanOrEqual(validFrom)

  // 4. Paid
  const onTime = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  const paid = ((await onTime.events) as EventRecord[]).find(({ event }) => client.api.events.treasury.Paid.is(event))
  assert(paid, 'payout at valid_from did not succeed')
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobBefore + amount)
}

/**
 * A spend cannot be paid out once its window has closed, and stays pending.
 *
 * With `valid_from = now - PayoutPeriod + 1` the spend is approved with one relay block of window
 * left, which has passed by the time a signed payout runs in a later block.
 *
 * 1. Approve a spend whose window ends one relay block after the agenda block
 * 2. Verify the payout block will be past the window
 * 3. Pay out, and verify it failed with SpendExpired, the spend is still pending and bob was not paid
 */
async function payoutAfterWindowFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const provider = client.config.properties.schedulerBlockProvider
  const offset = relayStep(client)
  const payoutPeriod = client.api.consts.treasury.payoutPeriod.toNumber()
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Window of one relay block
  const scheduledAt = await getBlockNumber(client.api, provider)
  const index = await approveSpend(
    client,
    primaryAsset,
    amount,
    { Origins: 'BigSpender' },
    scheduledAt - payoutPeriod + 1,
  )
  const expireAt = (await client.api.query.treasury.spends(index)).unwrap().expireAt.toNumber()
  expect(expireAt).toBe(scheduledAt + 1)

  // 2. Precondition: the payout block's relay parent is at or past expire_at
  expect((await getBlockNumber(client.api, provider)) + offset).toBeGreaterThanOrEqual(expireAt)
  const bobBefore = await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)

  // 3. Too late
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  expectTreasuryError(client, extrinsicError(client, (await tx.events) as EventRecord[]), 'SpendExpired')
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isPending).toBe(true)
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobBefore)
}

/**
 * A spend can be paid out only once.
 *
 * 1. Approve a spend and pay it out
 * 2. Pay it out a second time
 * 3. Verify the second payout failed with AlreadyAttempted and bob was paid only once
 */
async function payoutTwiceFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. First payout
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })
  await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isAttempted).toBe(true)
  const bobAfterFirst = await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)

  // 2. Second payout
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // 3. Rejected
  expectTreasuryError(client, extrinsicError(client, (await tx.events) as EventRecord[]), 'AlreadyAttempted')
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobAfterFirst)
}

/**
 * A payout of an index with no spend is refused.
 *
 * 1. Take the next unused spend index, and verify nothing is stored under it
 * 2. Pay it out, and verify the payout failed with InvalidIndex
 */
async function payoutUnknownIndexFails(client: Client<any, any>) {
  await endowNative(client, [testAccounts.alice.address])

  // 1. Unused index
  const index = (await client.api.query.treasury.spendCount()).toNumber()
  expect((await client.api.query.treasury.spends(index)).isNone).toBe(true)

  // 2. Rejected
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expectTreasuryError(client, extrinsicError(client, (await tx.events) as EventRecord[]), 'InvalidIndex')
}

/**
 * Root can approve a spend larger than the pot holds, but the payout then fails in the paymaster and
 * leaves the spend pending for a later retry.
 *
 * 1. Approve, as Root, a spend of one unit more than the pot's balance of the primary asset
 * 2. Pay it out, and verify it failed with PayoutError
 * 3. Verify the spend is still pending and neither the pot nor bob changed
 */
async function payoutBeyondPotFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const pot = potAccount(client)

  // 1. Root approves more than the pot holds
  const potBefore = await assetBalance(client, primaryAsset.holding, pot)
  const index = await approveSpend(client, primaryAsset, potBefore + 1n, { system: 'Root' })
  const bobBefore = await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)

  // 2. Payout fails in the paymaster
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expectTreasuryError(client, extrinsicError(client, (await tx.events) as EventRecord[]), 'PayoutError')

  // 3. Nothing moved
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isPending).toBe(true)
  expect(await assetBalance(client, primaryAsset.holding, pot)).toBe(potBefore)
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobBefore)
}

/**
 * `payout` requires a signed origin, so even Root cannot call it.
 *
 * 1. Approve a spend
 * 2. Schedule its payout with a Root origin
 * 3. Verify the call failed with BadOrigin and the spend is still pending
 */
async function payoutFromRootFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })

  // 2. Root payout
  const when = await scheduleCall(client, client.api.tx.treasury.payout(index), { system: 'Root' })
  await client.dev.newBlock()

  // 3. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'Root payout succeeded')
  expect(result.asErr.isBadOrigin).toBe(true)
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isPending).toBe(true)
}

/// -------
/// Tests - Check status
/// -------

/**
 * After a successful payout, `check_status` removes the spend and refunds its own fee.
 *
 * 1. Approve and pay out a spend
 * 2. Call `check_status` signed by alice, and verify the SpendProcessed event
 * 3. Verify the spend is removed
 * 4. Verify the extrinsic was marked as not paying a fee and alice's balance did not change
 */
async function checkStatusAfterPayout(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve and pay out
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })
  await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isAttempted).toBe(true)
  const aliceBefore = await freeBalance(client, testAccounts.alice.address)

  // 2. check_status
  const tx = await sendTransaction(client.api.tx.treasury.checkStatus(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  await checkEvents(tx, { section: 'treasury', method: 'SpendProcessed' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('check status after payout: SpendProcessed event')

  const events = (await tx.events) as EventRecord[]
  const processed = events.find(({ event }) => client.api.events.treasury.SpendProcessed.is(event))
  assert(processed, 'check_status did not process the spend')
  assert(client.api.events.treasury.SpendProcessed.is(processed.event))
  expect(processed.event.data.index.toNumber()).toBe(index)

  // 3. Removed
  expect((await client.api.query.treasury.spends(index)).isNone).toBe(true)

  // 4. Fee refunded
  const success = events.find(({ event }) => client.api.events.system.ExtrinsicSuccess.is(event))
  assert(success && client.api.events.system.ExtrinsicSuccess.is(success.event))
  expect(success.event.data.dispatchInfo.paysFee.isNo).toBe(true)
  expect(await freeBalance(client, testAccounts.alice.address)).toBe(aliceBefore)
}

/**
 * Once its window has closed, a spend that was never paid out is removed by `check_status`.
 *
 * 1. Approve a spend whose window ends one relay block after the agenda block
 * 2. Verify the check block will be past the window
 * 3. Call `check_status`, and verify the SpendProcessed event and that no fee was paid
 * 4. Verify the spend is removed and bob was never paid
 */
async function checkStatusRemovesExpiredSpend(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const provider = client.config.properties.schedulerBlockProvider
  const offset = relayStep(client)
  const payoutPeriod = client.api.consts.treasury.payoutPeriod.toNumber()
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Window of one relay block
  const scheduledAt = await getBlockNumber(client.api, provider)
  const bobBefore = await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)
  const index = await approveSpend(
    client,
    primaryAsset,
    amount,
    { Origins: 'BigSpender' },
    scheduledAt - payoutPeriod + 1,
  )
  const expireAt = (await client.api.query.treasury.spends(index)).unwrap().expireAt.toNumber()

  // 2. Precondition: the check block's relay parent is strictly past expire_at
  expect((await getBlockNumber(client.api, provider)) + offset).toBeGreaterThan(expireAt)

  // 3. check_status
  const tx = await sendTransaction(client.api.tx.treasury.checkStatus(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  await checkEvents(tx, { section: 'treasury', method: 'SpendProcessed' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('check status of expired spend: SpendProcessed event')

  const events = (await tx.events) as EventRecord[]
  const processed = events.find(({ event }) => client.api.events.treasury.SpendProcessed.is(event))
  assert(processed, 'check_status did not remove the expired spend')
  assert(client.api.events.treasury.SpendProcessed.is(processed.event))
  expect(processed.event.data.index.toNumber()).toBe(index)
  const success = events.find(({ event }) => client.api.events.system.ExtrinsicSuccess.is(event))
  assert(success && client.api.events.system.ExtrinsicSuccess.is(success.event))
  expect(success.event.data.dispatchInfo.paysFee.isNo).toBe(true)

  // 4. Removed, never paid
  expect((await client.api.query.treasury.spends(index)).isNone).toBe(true)
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobBefore)
}

/**
 * `check_status` of a spend that was neither paid out nor expired is refused and leaves it alone.
 *
 * 1. Approve a spend
 * 2. Call `check_status`, and verify it failed with NotAttempted
 * 3. Verify the spend is still stored and pending
 */
async function checkStatusOfPendingSpendFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })

  // 2. Rejected
  const tx = await sendTransaction(client.api.tx.treasury.checkStatus(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expectTreasuryError(client, extrinsicError(client, (await tx.events) as EventRecord[]), 'NotAttempted')

  // 3. Untouched
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isPending).toBe(true)
}

/**
 * `check_status` of an index with no spend is refused.
 *
 * 1. Take the next unused spend index, and verify nothing is stored under it
 * 2. Call `check_status`, and verify it failed with InvalidIndex
 */
async function checkStatusUnknownIndexFails(client: Client<any, any>) {
  await endowNative(client, [testAccounts.alice.address])

  // 1. Unused index
  const index = (await client.api.query.treasury.spendCount()).toNumber()
  expect((await client.api.query.treasury.spends(index)).isNone).toBe(true)

  // 2. Rejected
  const tx = await sendTransaction(client.api.tx.treasury.checkStatus(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expectTreasuryError(client, extrinsicError(client, (await tx.events) as EventRecord[]), 'InvalidIndex')
}

/**
 * `check_status` requires a signed origin, so even Root cannot call it.
 *
 * 1. Approve and pay out a spend, so that a signed `check_status` would succeed
 * 2. Schedule `check_status` with a Root origin
 * 3. Verify the call failed with BadOrigin and the spend is still stored
 */
async function checkStatusFromRootFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve and pay out
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })
  await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isAttempted).toBe(true)

  // 2. Root check_status
  const when = await scheduleCall(client, client.api.tx.treasury.checkStatus(index), { system: 'Root' })
  await client.dev.newBlock()

  // 3. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'Root check_status succeeded')
  expect(result.asErr.isBadOrigin).toBe(true)
  expect((await client.api.query.treasury.spends(index)).isSome).toBe(true)
}

/// -------
/// Tests - Void
/// -------

/**
 * `Treasurer` voids a pending spend, which is removed and can no longer be paid out.
 *
 * 1. Approve a spend
 * 2. Schedule `void_spend` as `Treasurer`, and verify the AssetSpendVoided event
 * 3. Verify the spend is removed
 * 4. Pay out the voided index, and verify it failed with InvalidIndex and bob was not paid
 */
async function voidSpendByTreasurer(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })
  const bobBefore = await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)

  // 2. Void
  const when = await scheduleCall(client, client.api.tx.treasury.voidSpend(index), { Origins: 'Treasurer' })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, when)).isOk).toBe(true)

  await checkSystemEvents(client, { section: 'treasury', method: 'AssetSpendVoided' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('void by Treasurer: AssetSpendVoided event')

  const voided = (await client.api.query.system.events()).find(({ event }) =>
    client.api.events.treasury.AssetSpendVoided.is(event),
  )
  assert(voided && client.api.events.treasury.AssetSpendVoided.is(voided.event))
  expect(voided.event.data.index.toNumber()).toBe(index)

  // 3. Removed
  expect((await client.api.query.treasury.spends(index)).isNone).toBe(true)

  // 4. No longer payable
  const tx = await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expectTreasuryError(client, extrinsicError(client, (await tx.events) as EventRecord[]), 'InvalidIndex')
  expect(await assetBalance(client, primaryAsset.holding, testAccounts.bob.address)).toBe(bobBefore)
}

/**
 * Root, the other arm of the reject origin, also voids a pending spend.
 *
 * 1. Approve a spend
 * 2. Schedule `void_spend` as Root, and verify the AssetSpendVoided event
 * 3. Verify the spend is removed
 */
async function voidSpendByRoot(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })

  // 2. Void
  const when = await scheduleCall(client, client.api.tx.treasury.voidSpend(index), { system: 'Root' })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, when)).isOk).toBe(true)

  const voided = (await client.api.query.system.events()).find(({ event }) =>
    client.api.events.treasury.AssetSpendVoided.is(event),
  )
  assert(voided && client.api.events.treasury.AssetSpendVoided.is(voided.event))
  expect(voided.event.data.index.toNumber()).toBe(index)

  // 3. Removed
  expect((await client.api.query.treasury.spends(index)).isNone).toBe(true)
}

/**
 * A Spender track can approve spends but is not a reject origin, so it cannot void them.
 *
 * 1. Approve a spend as `BigSpender`
 * 2. Schedule `void_spend` as `BigSpender`
 * 3. Verify the call failed with BadOrigin and the spend is still pending
 */
async function voidSpendBySpenderFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })

  // 2. Void as the same track
  const when = await scheduleCall(client, client.api.tx.treasury.voidSpend(index), { Origins: 'BigSpender' })
  await client.dev.newBlock()

  // 3. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'BigSpender voided a spend')
  expect(result.asErr.isBadOrigin).toBe(true)
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isPending).toBe(true)
}

/**
 * A spend that has been paid out cannot be voided.
 *
 * 1. Approve and pay out a spend
 * 2. Schedule `void_spend` as `Treasurer`
 * 3. Verify the call failed with AlreadyAttempted and the spend is still Attempted
 */
async function voidAfterPayoutFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const { primaryAsset } = testConfig
  await endowNative(client, [testAccounts.alice.address])
  const amount = SPEND_MIN_BALANCES * (await minimumBalance(client, primaryAsset.holding))

  // 1. Approve and pay out
  const index = await approveSpend(client, primaryAsset, amount, { Origins: 'BigSpender' })
  await sendTransaction(client.api.tx.treasury.payout(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isAttempted).toBe(true)

  // 2. Void
  const when = await scheduleCall(client, client.api.tx.treasury.voidSpend(index), { Origins: 'Treasurer' })
  await client.dev.newBlock()

  // 3. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'a paid-out spend was voided')
  expectTreasuryError(client, result.asErr, 'AlreadyAttempted')
  expect((await client.api.query.treasury.spends(index)).unwrap().status.isAttempted).toBe(true)
}

/**
 * Voiding an index with no spend is refused.
 *
 * 1. Take the next unused spend index, and verify nothing is stored under it
 * 2. Schedule `void_spend` as `Treasurer`, and verify it failed with InvalidIndex
 */
async function voidUnknownIndexFails(client: Client<any, any>) {
  // 1. Unused index
  const index = (await client.api.query.treasury.spendCount()).toNumber()
  expect((await client.api.query.treasury.spends(index)).isNone).toBe(true)

  // 2. Rejected
  const when = await scheduleCall(client, client.api.tx.treasury.voidSpend(index), { Origins: 'Treasurer' })
  await client.dev.newBlock()
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'voiding an unknown index succeeded')
  expectTreasuryError(client, result.asErr, 'InvalidIndex')
}

/// -------
/// Tests - Legacy spend_local queue
/// -------

/**
 * Move the spend period anchor back by one period, so that the treasury hook in the next block
 * runs a spend period. The hook sees the previous block's relay parent as "now", which is the
 * value read here.
 */
async function rewindSpendPeriod(client: Client<any, any>): Promise<number> {
  const now = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  await client.dev.setStorage({
    Treasury: { lastSpendPeriod: now - client.api.consts.treasury.spendPeriod.toNumber() },
  })
  return now
}

/**
 * Assert that no approved bounty is waiting for funds, since bounties draw on the same budget in a
 * spend period and would change the amounts the spend period tests check.
 */
async function expectNoBountyApprovals(client: Client<any, any>): Promise<void> {
  const bounties = (client.api.query as any).bounties
  if (bounties) expect((await bounties.bountyApprovals()).length).toBe(0)
}

/** The only event of the given treasury method in the latest block, asserting there is exactly one. */
async function onlyTreasuryEvent(client: Client<any, any>, method: string) {
  const events = (await client.api.query.system.events()).filter(
    ({ event }) => event.section === 'treasury' && event.method === method,
  )
  expect(events, `expected one treasury.${method} event`).toHaveLength(1)
  return events[0].event
}

/**
 * A Spender track queues a native spend with `spend_local`.
 *
 * The proposal is recorded with charlie as both proposer and beneficiary and no bond, as the
 * pallet does for this call, and waits in the approval queue for the next spend period.
 *
 * 1. Record the proposal count, and schedule `spend_local` to charlie as `SmallTipper`
 * 2. Verify the call succeeded and the SpendApproved event carries the index, amount and charlie
 * 3. Verify the stored proposal, the approval queue and the proposal count
 */
async function spendLocalQueuesProposal(client: Client<any, any>) {
  const amount = SPEND_MIN_BALANCES * client.api.consts.balances.existentialDeposit.toBigInt()
  const charlie = chainAddress(client, testAccounts.charlie.address)

  // 1. Schedule spend_local
  const index = (await client.api.query.treasury.proposalCount()).toNumber()
  const when = await scheduleCall(client, client.api.tx.treasury.spendLocal(amount, charlie), {
    Origins: 'SmallTipper',
  })
  await client.dev.newBlock()

  // 2. Approved
  expect((await dispatchedResult(client, when)).isOk).toBe(true)

  await checkSystemEvents(client, { section: 'treasury', method: 'SpendApproved' })
    .redact({ redactKeys: /^proposalIndex$/ })
    .toMatchSnapshot('spend_local: SpendApproved event')

  const approved = await onlyTreasuryEvent(client, 'SpendApproved')
  assert(client.api.events.treasury.SpendApproved.is(approved))
  expect(approved.data.proposalIndex.toNumber()).toBe(index)
  expect(approved.data.amount.toBigInt()).toBe(amount)
  expect(approved.data.beneficiary.toString()).toBe(charlie)

  // 3. Stored and queued
  const proposal = await client.api.query.treasury.proposals(index)
  assert(proposal.isSome, 'proposal not stored')
  expect(proposal.unwrap().proposer.toString()).toBe(charlie)
  expect(proposal.unwrap().beneficiary.toString()).toBe(charlie)
  expect(proposal.unwrap().value.toBigInt()).toBe(amount)
  expect(proposal.unwrap().bond.toBigInt()).toBe(0n)
  expect((await client.api.query.treasury.approvals()).map((i) => i.toNumber())).toContain(index)
  expect((await client.api.query.treasury.proposalCount()).toNumber()).toBe(index + 1)
}

/**
 * The spend period pays every queued proposal from the pot and reports the budget before and after.
 *
 * 1. Queue a `spend_local` to charlie, and verify no bounty is waiting on the same budget
 * 2. Rewind the spend period anchor, and record the pot and charlie's balance
 * 3. Build a block, and verify the Spending, Awarded and Rollover events
 * 4. Verify the budget balances: Rollover is the starting budget less the award, with no burn
 * 5. Verify charlie was paid and the proposal left both the queue and storage
 */
async function spendPeriodAwardsQueuedProposal(client: Client<any, any>) {
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  const amount = SPEND_MIN_BALANCES * ed
  const charlie = chainAddress(client, testAccounts.charlie.address)
  const pot = potAccount(client)

  // 1. Queue
  const index = (await client.api.query.treasury.proposalCount()).toNumber()
  const when = await scheduleCall(client, client.api.tx.treasury.spendLocal(amount, charlie), {
    Origins: 'SmallTipper',
  })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, when)).isOk).toBe(true)
  await expectNoBountyApprovals(client)

  // 2. Rewind
  const periodStart = await rewindSpendPeriod(client)
  const budget = (await freeBalance(client, pot)) - ed
  const charlieBefore = await freeBalance(client, charlie)

  // 3. Spend period
  await client.dev.newBlock()

  await checkSystemEvents(client, 'treasury')
    .redact({ redactKeys: /^(proposalIndex|budgetRemaining|rolloverBalance)$/ })
    .toMatchSnapshot('spend period: treasury events')

  const spending = await onlyTreasuryEvent(client, 'Spending')
  assert(client.api.events.treasury.Spending.is(spending))
  expect(spending.data.budgetRemaining.toBigInt()).toBe(budget)

  const awarded = await onlyTreasuryEvent(client, 'Awarded')
  assert(client.api.events.treasury.Awarded.is(awarded))
  expect(awarded.data.proposalIndex.toNumber()).toBe(index)
  expect(awarded.data.award.toBigInt()).toBe(amount)
  expect(awarded.data.account.toString()).toBe(charlie)

  // 4. Budget balances
  const rollover = await onlyTreasuryEvent(client, 'Rollover')
  assert(client.api.events.treasury.Rollover.is(rollover))
  expect(rollover.data.rolloverBalance.toBigInt()).toBe(budget - amount)
  const burnt = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.treasury.Burnt.is(event),
  )
  expect(burnt).toHaveLength(0)
  expect((await client.api.query.treasury.lastSpendPeriod()).unwrap().toNumber()).toBe(periodStart)

  // 5. Paid and cleared
  expect(await freeBalance(client, charlie)).toBe(charlieBefore + amount)
  expect((await client.api.query.treasury.proposals(index)).isNone).toBe(true)
  expect((await client.api.query.treasury.approvals()).map((i) => i.toNumber())).not.toContain(index)
}

/**
 * `spend_local` is capped by the Spender track's limit, like `spend`.
 *
 * 1. Record the proposal count, and schedule `spend_local` of one planck over the limit as `SmallTipper`
 * 2. Verify the call failed with InsufficientPermission and no proposal was recorded
 */
async function spendLocalOverLimitFails(client: Client<any, any>, testConfig: TreasuryTestConfig) {
  const charlie = chainAddress(client, testAccounts.charlie.address)

  // 1. Over the limit
  const countBefore = (await client.api.query.treasury.proposalCount()).toNumber()
  const when = await scheduleCall(
    client,
    client.api.tx.treasury.spendLocal(testConfig.smallTipperLimit + 1n, charlie),
    { Origins: 'SmallTipper' },
  )
  await client.dev.newBlock()

  // 2. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'spend_local over the limit was approved')
  expectTreasuryError(client, result.asErr, 'InsufficientPermission')
  expect((await client.api.query.treasury.proposalCount()).toNumber()).toBe(countBefore)
}

/**
 * The approval queue holds at most `MaxApprovals` proposals.
 *
 * Filling the queue with real calls would take `MaxApprovals` dispatches, so all but one slot are
 * filled by writing queued proposals into storage, shaped as `spend_local` would record them. The
 * last slot and the overflow are then exercised with the real call.
 *
 * 1. Verify the queue is empty, then write `MaxApprovals - 1` queued proposals to charlie
 * 2. Schedule `spend_local` as `SmallTipper`, and verify it took the last slot
 * 3. Schedule another `spend_local`, and verify it failed with TooManyApprovals
 * 4. Verify the queue is still full and the proposal count did not move on the failure
 */
async function spendLocalIntoFullQueueFails(client: Client<any, any>) {
  const maxApprovals = client.api.consts.treasury.maxApprovals.toNumber()
  const amount = SPEND_MIN_BALANCES * client.api.consts.balances.existentialDeposit.toBigInt()
  const charlie = chainAddress(client, testAccounts.charlie.address)

  // 1. Fill all but one slot
  expect((await client.api.query.treasury.approvals()).length).toBe(0)
  const first = (await client.api.query.treasury.proposalCount()).toNumber()
  const filler = Array.from({ length: maxApprovals - 1 }, (_, k) => first + k)
  await client.dev.setStorage({
    Treasury: {
      proposals: filler.map((i) => [[i], { proposer: charlie, value: amount, beneficiary: charlie, bond: 0 }]),
      approvals: filler,
      proposalCount: first + filler.length,
    },
  })
  expect((await client.api.query.treasury.approvals()).length).toBe(maxApprovals - 1)

  // 2. Last slot
  const lastSlot = await scheduleCall(client, client.api.tx.treasury.spendLocal(amount, charlie), {
    Origins: 'SmallTipper',
  })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, lastSlot)).isOk).toBe(true)
  const approved = await onlyTreasuryEvent(client, 'SpendApproved')
  assert(client.api.events.treasury.SpendApproved.is(approved))
  expect(approved.data.proposalIndex.toNumber()).toBe(first + maxApprovals - 1)
  expect((await client.api.query.treasury.approvals()).length).toBe(maxApprovals)

  // 3. Overflow
  const countBefore = (await client.api.query.treasury.proposalCount()).toNumber()
  const overflow = await scheduleCall(client, client.api.tx.treasury.spendLocal(amount, charlie), {
    Origins: 'SmallTipper',
  })
  await client.dev.newBlock()
  const result = await dispatchedResult(client, overflow)
  assert(result.isErr, 'spend_local into a full queue was approved')
  expectTreasuryError(client, result.asErr, 'TooManyApprovals')

  // 4. Unchanged
  expect((await client.api.query.treasury.approvals()).length).toBe(maxApprovals)
  expect((await client.api.query.treasury.proposalCount()).toNumber()).toBe(countBefore)
}

/**
 * `Treasurer` removes a queued proposal, which the next spend period then skips. The proposal
 * itself stays in storage: `remove_approval` only edits the queue.
 *
 * 1. Queue a `spend_local` to charlie
 * 2. Schedule `remove_approval` as `Treasurer`, and verify it succeeded
 * 3. Verify the queue no longer holds the proposal but the proposal is still stored unchanged
 * 4. Run a spend period, and verify it awarded nothing and charlie was not paid
 */
async function removeApprovalDropsProposal(client: Client<any, any>) {
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  const amount = SPEND_MIN_BALANCES * ed
  const charlie = chainAddress(client, testAccounts.charlie.address)
  const pot = potAccount(client)

  // 1. Queue
  const index = (await client.api.query.treasury.proposalCount()).toNumber()
  const queued = await scheduleCall(client, client.api.tx.treasury.spendLocal(amount, charlie), {
    Origins: 'SmallTipper',
  })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, queued)).isOk).toBe(true)
  const proposalBefore = (await client.api.query.treasury.proposals(index)).toHex()

  // 2. Remove
  const removed = await scheduleCall(client, client.api.tx.treasury.removeApproval(index), { Origins: 'Treasurer' })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, removed)).isOk).toBe(true)

  // 3. Queue edited, proposal kept
  expect((await client.api.query.treasury.approvals()).map((i) => i.toNumber())).not.toContain(index)
  expect((await client.api.query.treasury.proposals(index)).toHex()).toBe(proposalBefore)

  // 4. Spend period skips it
  await expectNoBountyApprovals(client)
  await rewindSpendPeriod(client)
  const budget = (await freeBalance(client, pot)) - ed
  const charlieBefore = await freeBalance(client, charlie)
  await client.dev.newBlock()

  const awarded = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.treasury.Awarded.is(event),
  )
  expect(awarded).toHaveLength(0)
  const rollover = await onlyTreasuryEvent(client, 'Rollover')
  assert(client.api.events.treasury.Rollover.is(rollover))
  expect(rollover.data.rolloverBalance.toBigInt()).toBe(budget)
  expect(await freeBalance(client, charlie)).toBe(charlieBefore)
}

/**
 * `remove_approval` of a proposal that is not in the queue is refused.
 *
 * 1. Take the next unused proposal index, and verify the queue does not hold it
 * 2. Schedule `remove_approval` as `Treasurer`, and verify it failed with ProposalNotApproved
 */
async function removeApprovalOfUnqueuedFails(client: Client<any, any>) {
  // 1. Not queued
  const index = (await client.api.query.treasury.proposalCount()).toNumber()
  expect((await client.api.query.treasury.approvals()).map((i) => i.toNumber())).not.toContain(index)

  // 2. Rejected
  const when = await scheduleCall(client, client.api.tx.treasury.removeApproval(index), { Origins: 'Treasurer' })
  await client.dev.newBlock()
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'removing an unqueued proposal succeeded')
  expectTreasuryError(client, result.asErr, 'ProposalNotApproved')
}

/**
 * A Spender track can queue a proposal but cannot remove one.
 *
 * 1. Queue a `spend_local` as `SmallTipper`
 * 2. Schedule `remove_approval` as `SmallTipper`
 * 3. Verify the call failed with BadOrigin and the proposal is still queued
 */
async function removeApprovalBySpenderFails(client: Client<any, any>) {
  const amount = SPEND_MIN_BALANCES * client.api.consts.balances.existentialDeposit.toBigInt()
  const charlie = chainAddress(client, testAccounts.charlie.address)

  // 1. Queue
  const index = (await client.api.query.treasury.proposalCount()).toNumber()
  const queued = await scheduleCall(client, client.api.tx.treasury.spendLocal(amount, charlie), {
    Origins: 'SmallTipper',
  })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, queued)).isOk).toBe(true)

  // 2. Remove as the same track
  const when = await scheduleCall(client, client.api.tx.treasury.removeApproval(index), { Origins: 'SmallTipper' })
  await client.dev.newBlock()

  // 3. Rejected
  const result = await dispatchedResult(client, when)
  assert(result.isErr, 'SmallTipper removed an approval')
  expect(result.asErr.isBadOrigin).toBe(true)
  expect((await client.api.query.treasury.approvals()).map((i) => i.toNumber())).toContain(index)
}

/// -------
/// Tests - Pot accounting
/// -------

/**
 * When the pot's balance changes, the next block's treasury hook marks the new pot as inactive
 * issuance and reports the old and new values.
 *
 * 1. Verify the recorded inactive amount equals the pot, so the hook has nothing pending
 * 2. Transfer 100 existential deposits into the pot from alice
 * 3. Build the next block, and verify the UpdatedInactive event reports the old and new pot
 * 4. Verify the recorded inactive amount now equals the new pot
 */
async function potChangeUpdatesInactive(client: Client<any, any>) {
  await endowNative(client, [testAccounts.alice.address])
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  const pot = potAccount(client)
  const transfer = SPEND_MIN_BALANCES * ed

  // 1. Nothing pending
  const potBefore = (await freeBalance(client, pot)) - ed
  expect((await client.api.query.treasury.deactivated()).toBigInt()).toBe(potBefore)

  // 2. Transfer in
  await sendTransaction(client.api.tx.balances.transferKeepAlive(pot, transfer).signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect((await freeBalance(client, pot)) - ed).toBe(potBefore + transfer)

  // 3. Next block's hook
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'treasury', method: 'UpdatedInactive' })
    .redact({ redactKeys: /^(reactivated|deactivated)$/ })
    .toMatchSnapshot('pot change: UpdatedInactive event')

  const updated = await onlyTreasuryEvent(client, 'UpdatedInactive')
  assert(client.api.events.treasury.UpdatedInactive.is(updated))
  expect(updated.data.reactivated.toBigInt()).toBe(potBefore)
  expect(updated.data.deactivated.toBigInt()).toBe(potBefore + transfer)

  // 4. Recorded
  expect((await client.api.query.treasury.deactivated()).toBigInt()).toBe(potBefore + transfer)
}

/**
 * On runtimes that route slashes into the treasury, a rejected bounty's bond is deposited into the
 * pot through the treasury's imbalance handler.
 *
 * 1. Propose a bounty as alice, and record her reserved balance and the pot
 * 2. Close the bounty as `Treasurer`, which slashes the bond
 * 3. Verify the Deposit event carries the bond
 * 4. Verify the pot grew by the bond and alice's reserve released it
 */
async function slashedBondIsDeposited(
  client: Client<any, any>,
  testConfig: TreasuryTestConfig,
  ctx: { skip: (reason?: string) => void } | undefined,
) {
  if (!testConfig.slashesFundTreasury) {
    ctx?.skip('this runtime does not pay slashed funds into the treasury')
    return
  }
  await endowNative(client, [testAccounts.alice.address])
  const pot = potAccount(client)
  const bounties = client.api.consts.bounties
  const bond =
    bounties.bountyDepositBase.toBigInt() + bounties.dataDepositPerByte.toBigInt() * BigInt(BOUNTY_DESCRIPTION.length)

  // 1. Propose
  const reservedBefore = (await client.api.query.system.account(testAccounts.alice.address)).data.reserved.toBigInt()
  const bountyIndex = (await client.api.query.bounties.bountyCount()).toNumber()
  await sendTransaction(
    client.api.tx.bounties
      .proposeBounty(bounties.bountyValueMinimum.toBigInt(), BOUNTY_DESCRIPTION)
      .signAsync(testAccounts.alice),
  )
  await client.dev.newBlock()
  expect((await client.api.query.system.account(testAccounts.alice.address)).data.reserved.toBigInt()).toBe(
    reservedBefore + bond,
  )
  const potBefore = await freeBalance(client, pot)

  // 2. Close as Treasurer
  const when = await scheduleCall(client, client.api.tx.bounties.closeBounty(bountyIndex), { Origins: 'Treasurer' })
  await client.dev.newBlock()
  expect((await dispatchedResult(client, when)).isOk).toBe(true)

  // 3. Deposit
  await checkSystemEvents(client, { section: 'treasury', method: 'Deposit' }).toMatchSnapshot(
    'slashed bond: Deposit event',
  )

  const deposit = await onlyTreasuryEvent(client, 'Deposit')
  assert(client.api.events.treasury.Deposit.is(deposit))
  expect(deposit.data.value.toBigInt()).toBe(bond)

  // 4. Balances
  expect(await freeBalance(client, pot)).toBe(potBefore + bond)
  expect((await client.api.query.system.account(testAccounts.alice.address)).data.reserved.toBigInt()).toBe(
    reservedBefore,
  )
}

/**
 * Whether the runtime has dynamic treasury parameters (burn portion and burn destination). This is
 * read from the variants of the `parameters` pallet's key type in metadata.
 */
function hasTreasuryParameters(client: Client<any, any>): boolean {
  const parameters = (client.api.query as any).parameters?.parameters
  if (!parameters) return false
  const keyType = client.api.registry.lookup.getSiType(parameters.creator.meta.type.asMap.key)
  return keyType.def.isVariant && keyType.def.asVariant.variants.some((v) => v.name.toString() === 'Treasury')
}

/**
 * On runtimes with a configurable burn, a spend period burns the configured portion of the budget
 * into the burn destination.
 *
 * 1. Set a 1% burn portion and dave as the burn destination, as Root in one block
 * 2. Rewind the spend period anchor, and record the pot and dave's balance
 * 3. Run the spend period, and verify the Spending, Burnt and Rollover events
 * 4. Verify the burn is 1% of the budget and the budget balances: burnt plus rollover
 * 5. Verify dave received exactly the burnt amount and the pot paid it
 */
async function spendPeriodBurnsToDestination(
  client: Client<any, any>,
  ctx: { skip: (reason?: string) => void } | undefined,
) {
  if (!hasTreasuryParameters(client)) {
    ctx?.skip('this runtime has no configurable treasury burn')
    return
  }
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  const pot = potAccount(client)
  const dave = chainAddress(client, testAccounts.dave.address)
  await endowNative(client, [dave])

  // 1. Configure the burn
  const setPortion = client.api.tx.parameters.setParameter({
    Treasury: { BurnPortion: [null, BURN_PORTION_PPM] },
  } as any)
  const setDestination = client.api.tx.parameters.setParameter({ Treasury: { BurnDestination: [null, dave] } } as any)
  const provider = client.config.properties.schedulerBlockProvider
  const when = await nextSchedulableBlockNum(client.api, provider)
  for (const call of [setPortion, setDestination]) {
    expect(call.method.encodedLength).toBeLessThanOrEqual(INLINE_CALL_LIMIT)
  }
  await scheduleCallListWithOrigin(
    client,
    [setPortion, setDestination].map((call) => ({ call: { Inline: call.method.toHex() }, origin: { system: 'Root' } })),
    provider,
  )
  await client.dev.newBlock()
  expect((await dispatchedResult(client, when, 0)).isOk).toBe(true)
  expect((await dispatchedResult(client, when, 1)).isOk).toBe(true)
  await expectNoBountyApprovals(client)
  expect((await client.api.query.treasury.approvals()).length).toBe(0)

  // 2. Rewind
  await rewindSpendPeriod(client)
  const budget = (await freeBalance(client, pot)) - ed
  const daveBefore = await freeBalance(client, dave)

  // 3. Spend period
  await client.dev.newBlock()

  await checkSystemEvents(client, 'treasury')
    .redact({ redactKeys: /^(budgetRemaining|burntFunds|rolloverBalance)$/ })
    .toMatchSnapshot('spend period with burn: treasury events')

  const spending = await onlyTreasuryEvent(client, 'Spending')
  assert(client.api.events.treasury.Spending.is(spending))
  expect(spending.data.budgetRemaining.toBigInt()).toBe(budget)
  const burntEvent = await onlyTreasuryEvent(client, 'Burnt')
  assert(client.api.events.treasury.Burnt.is(burntEvent))
  const burnt = burntEvent.data.burntFunds.toBigInt()
  const rollover = await onlyTreasuryEvent(client, 'Rollover')
  assert(client.api.events.treasury.Rollover.is(rollover))

  // 4. 1% of the budget, within the rounding of a `Permill` product
  const expectedBurn = (budget * BURN_PORTION_PPM) / 1_000_000n
  expect(burnt >= expectedBurn - 1n && burnt <= expectedBurn + 1n, `burnt ${burnt}, expected ~${expectedBurn}`).toBe(
    true,
  )
  expect(burnt + rollover.data.rolloverBalance.toBigInt()).toBe(budget)

  // 5. Balances
  expect(await freeBalance(client, dave)).toBe(daveBefore + burnt)
  expect((await freeBalance(client, pot)) - ed).toBe(budget - burnt)
}

/// ----------
/// Test tree
/// ----------

export function treasuryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TreasuryTestConfig): RootTestTree {
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[client] = await createNetworks(chain)
      restoreSnapshot = captureSnapshot(client)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
      await client.dev.setHead(blockNumber)
    },
    afterAll: async () => {
      await client.api.disconnect().catch(() => {})
      await client.teardown().catch(() => {})
    },
    children: [
      {
        kind: 'describe',
        label: 'spend',
        children: [
          {
            kind: 'test',
            label: 'spend by BigSpender - AssetSpendApproved, spend stored as Pending',
            testFn: () => spendApprovedByBigSpender(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend at the SmallTipper limit - approved',
            testFn: () => spendAtSmallTipperLimit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend one unit over the SmallTipper limit - InsufficientPermission',
            testFn: () => spendOverSmallTipperLimitFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend of a rated asset at the converted SmallTipper limit - approved',
            testFn: () => ratedSpendAtConvertedLimit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend of a rated asset one unit over the converted limit - InsufficientPermission',
            testFn: () => ratedSpendOverConvertedLimitFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'two spends in one batch over the SmallTipper limit together - InsufficientPermission',
            testFn: () => batchedSpendsOverLimitFail(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend from a signed origin - BadOrigin',
            testFn: () => spendFromSignedOriginFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend of an asset with no rate - FailedToConvertBalance',
            testFn: () => spendUnratedAssetFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend whose payout window already closed - SpendExpired',
            testFn: () => spendAlreadyExpiredFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend with valid_from in the past inside the window - approved and claimable at once',
            testFn: () => spendWithPastValidFromIsClaimable(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'payout',
        children: [
          {
            kind: 'test',
            label: 'payout - Paid, beneficiary credited, spend Attempted',
            testFn: () => payoutPaysBeneficiary(client, testConfig),
          },
          {
            kind: 'test',
            label: 'payout of a rated asset - asset moved, supply unchanged',
            testFn: () => ratedPayoutPreservesSupply(client, testConfig),
          },
          {
            kind: 'test',
            label: 'payout before valid_from - EarlyPayout, then Paid once reached',
            testFn: () => earlyPayoutFailsUntilValidFrom(client, testConfig),
          },
          {
            kind: 'test',
            label: 'payout after the window closes - SpendExpired',
            testFn: () => payoutAfterWindowFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'payout twice - AlreadyAttempted',
            testFn: () => payoutTwiceFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'payout of an unknown index - InvalidIndex',
            testFn: () => payoutUnknownIndexFails(client),
          },
          {
            kind: 'test',
            label: 'payout of a spend larger than the pot - PayoutError, spend stays Pending',
            testFn: () => payoutBeyondPotFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'payout from Root - BadOrigin',
            testFn: () => payoutFromRootFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'check_status',
        children: [
          {
            kind: 'test',
            label: 'check_status after payout - SpendProcessed, spend removed, fee refunded',
            testFn: () => checkStatusAfterPayout(client, testConfig),
          },
          {
            kind: 'test',
            label: 'check_status of an expired unpaid spend - SpendProcessed, spend removed',
            testFn: () => checkStatusRemovesExpiredSpend(client, testConfig),
          },
          {
            kind: 'test',
            label: 'check_status of a pending spend - NotAttempted',
            testFn: () => checkStatusOfPendingSpendFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'check_status of an unknown index - InvalidIndex',
            testFn: () => checkStatusUnknownIndexFails(client),
          },
          {
            kind: 'test',
            label: 'check_status from Root - BadOrigin',
            testFn: () => checkStatusFromRootFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'void_spend',
        children: [
          {
            kind: 'test',
            label: 'void_spend by Treasurer - AssetSpendVoided, spend can no longer be paid',
            testFn: () => voidSpendByTreasurer(client, testConfig),
          },
          {
            kind: 'test',
            label: 'void_spend by Root - AssetSpendVoided',
            testFn: () => voidSpendByRoot(client, testConfig),
          },
          {
            kind: 'test',
            label: 'void_spend by a Spender track - BadOrigin',
            testFn: () => voidSpendBySpenderFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'void_spend after payout - AlreadyAttempted',
            testFn: () => voidAfterPayoutFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'void_spend of an unknown index - InvalidIndex',
            testFn: () => voidUnknownIndexFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'spend_local queue',
        children: [
          {
            kind: 'test',
            label: 'spend_local by SmallTipper - SpendApproved, proposal queued',
            testFn: () => spendLocalQueuesProposal(client),
          },
          {
            kind: 'test',
            label: 'spend period - queued proposal Awarded, Spending and Rollover balance',
            testFn: () => spendPeriodAwardsQueuedProposal(client),
          },
          {
            kind: 'test',
            label: 'spend_local over the SmallTipper limit - InsufficientPermission',
            testFn: () => spendLocalOverLimitFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'spend_local into a full approval queue - TooManyApprovals',
            testFn: () => spendLocalIntoFullQueueFails(client),
          },
          {
            kind: 'test',
            label: 'remove_approval by Treasurer - proposal dropped from the queue and not paid',
            testFn: () => removeApprovalDropsProposal(client),
          },
          {
            kind: 'test',
            label: 'remove_approval of an unqueued proposal - ProposalNotApproved',
            testFn: () => removeApprovalOfUnqueuedFails(client),
          },
          {
            kind: 'test',
            label: 'remove_approval by a Spender track - BadOrigin',
            testFn: () => removeApprovalBySpenderFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'pot accounting',
        children: [
          {
            kind: 'test',
            label: 'pot balance change - UpdatedInactive in the next block',
            testFn: () => potChangeUpdatesInactive(client),
          },
          {
            kind: 'test',
            label: 'slashed bounty bond - Deposit into the pot',
            testFn: (ctx) => slashedBondIsDeposited(client, testConfig, ctx),
          },
          {
            kind: 'test',
            label: 'spend period with a burn configured - Burnt to the burn destination',
            testFn: (ctx) => spendPeriodBurnsToDestination(client, ctx),
          },
        ],
      },
    ],
  }
}
