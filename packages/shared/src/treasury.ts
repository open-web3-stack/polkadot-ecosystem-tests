import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { KeyringPair } from '@polkadot/keyring/types'
import type { FrameSupportTokensFungibleUnionOfNativeOrWithId, XcmVersionedLocation } from '@polkadot/types/lookup'
import type { Codec } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// Origins
const REJECT_ORIGIN = 'Treasurer'
const SPEND_ORIGIN = 'BigSpender'
const SMALL_TIPPER_ORIGIN = 'SmallTipper'

// initial funding balance for accounts
const TEST_ACCOUNT_BALANCE_MULTIPLIER = 10000n // 10,000x existential deposit

const SPEND_AMOUNT_MULTIPLIER = 100n // 100x existential deposit
const LARGE_SPEND_AMOUNT_MULTIPLIER = 100_000_000n // 100,000x existential deposit

// Native asset kind for spend tests
const ASSET_KIND = {
  v5: {
    location: {
      parents: 0,
      interior: 'Here', // Native asset
    },
    assetId: {
      parents: 1,
      interior: 'Here',
    },
  },
} as unknown as FrameSupportTokensFungibleUnionOfNativeOrWithId

// Beneficiary location(alice) for the treasury spend
const BENEFICIARY_LOCATION = {
  v4: {
    location: {
      parents: 0,
      interior: { Here: null }, // Location is Here for same parachain
    },
    accountId: {
      parents: 0,
      interior: {
        x1: [
          {
            accountId32: {
              network: null,
              id: testAccounts.alice.addressRaw,
            },
          },
        ],
      },
    },
  },
} as unknown as XcmVersionedLocation

// USDT on Asset Hub (assets pallet instance 50, asset id 1984), expressed as an XCM v4 locatable asset.
// `location` is the *consensus location* where the payment is made — `Here`, i.e. Asset Hub itself, since
// the treasury, the assets pallet, and the beneficiary all live on the same chain post-AHM. `assetId` is
// the local path to the USDT asset within the assets pallet. (This mirrors the native `ASSET_KIND` shape,
// where `location` is `Here` and only `assetId` differs.)
const USDT_ASSET_ID = 1984
const USDT_ASSET_KIND = {
  v4: {
    location: {
      parents: 0,
      interior: 'Here',
    },
    assetId: {
      parents: 0,
      interior: { x2: [{ palletInstance: 50 }, { generalIndex: USDT_ASSET_ID }] },
    },
  },
} as unknown as FrameSupportTokensFungibleUnionOfNativeOrWithId

/**
 * Setup accounts with funds for testing
 */
export async function setupTestAccounts<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>, accounts: string[] = ['alice', 'bob']) {
  const accountMap = {
    alice: testAccounts.alice.address,
    bob: testAccounts.bob.address,
    charlie: testAccounts.charlie.address,
    dave: testAccounts.dave.address,
  }

  const existentialDeposit = relayClient.api.consts.balances.existentialDeposit.toBigInt()
  const testAccountBalance = TEST_ACCOUNT_BALANCE_MULTIPLIER * existentialDeposit

  const accountData = accounts
    .filter((account) => accountMap[account as keyof typeof accountMap])
    .map((account) => [
      [accountMap[account as keyof typeof accountMap]],
      { providers: 1, data: { free: testAccountBalance } },
    ])

  await relayClient.dev.setStorage({
    System: {
      account: accountData,
    },
  })
}

async function getSpendCount<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>): Promise<number> {
  return (await assetHubClient.api.query.treasury.spendCount()).toNumber()
}

async function getSpendIndexFromEvent<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, eventType: 'AssetSpendApproved' | 'Paid'): Promise<number> {
  const records = (await assetHubClient.api.query.system.events()).filter((record) =>
    assetHubClient.api.events.treasury[eventType].is(record.event),
  )
  // Each lifecycle step under test emits exactly one such event in the block it produced.
  expect(records).toHaveLength(1)
  const [record] = records
  assert(assetHubClient.api.events.treasury[eventType].is(record.event))
  return record.event.data.index.toNumber()
}

/**
 * Helper: Query an account's USDT (assets pallet) balance, returning `0n` when no entry exists.
 */
async function getUsdtBalance<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, address: string): Promise<bigint> {
  const entry = await assetHubClient.api.query.assets.account(USDT_ASSET_ID, address)
  return entry.isNone ? 0n : entry.unwrap().balance.toBigInt()
}

/**
 * Helper: Assert that the most recent batch of scheduler-dispatched calls contains a dispatch failure
 * with the given treasury module error.
 *
 * Privileged treasury calls (`spend`, `void_spend`) are injected into the scheduler agenda and executed
 * by the scheduler, so their failure surfaces as an `Err(Module)` inside a `scheduler.Dispatched` event
 * rather than as an `ExtrinsicFailed` event.
 */
async function assertScheduledCallError<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, expectedError: { is: (error: any) => boolean }) {
  const events = await assetHubClient.api.query.system.events()
  const dispatchedEvents = events.filter((record) => assetHubClient.api.events.scheduler.Dispatched.is(record.event))
  assert(dispatchedEvents.length > 0, 'Expected at least one scheduler.Dispatched event')

  const foundExpectedError = dispatchedEvents.some((record) => {
    assert(assetHubClient.api.events.scheduler.Dispatched.is(record.event))
    const { result } = record.event.data
    return result.isErr && result.asErr.isModule && expectedError.is(result.asErr.asModule)
  })
  assert(foundExpectedError, 'Expected a Dispatched event carrying the expected treasury module error')
}

/**
 * Helper: Assert that the latest block contains an `ExtrinsicFailed` event whose dispatch error is the
 * given treasury module error.
 *
 * Signed treasury calls (`payout`, `check_status`) are submitted directly, so their failure surfaces as a
 * `system.ExtrinsicFailed` event.
 */
async function assertSignedExtrinsicError<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, expectedError: { is: (error: any) => boolean }) {
  const events = await assetHubClient.api.query.system.events()
  const [failedEvent] = events.filter((record) => assetHubClient.api.events.system.ExtrinsicFailed.is(record.event))
  assert(failedEvent, 'Expected an ExtrinsicFailed event')
  assert(assetHubClient.api.events.system.ExtrinsicFailed.is(failedEvent.event))

  const { dispatchError } = failedEvent.event.data
  assert(dispatchError.isModule, 'Expected a module dispatch error')
  expect(expectedError.is(dispatchError.asModule)).toBe(true)
}

/**
 * Helper: backdate (or postdate) the timing fields of an approved spend by rewriting its `Spends` storage
 * entry in place.
 *
 * The pallet derives `now` from its configured `BlockNumberProvider`, and a spend can only be claimed once
 * `now >= valid_from` and before `now > expire_at`.
 *
 * Reaching those bounds organically would require
 * advancing up to a whole `PayoutPeriod` of blocks (slow and provider-dependent).
 *
 * Instead, the spend is read back - its own `validFrom`/`expireAt` fields are already expressed in the provider's units - and only the timing fields are overwritten, leaving `asset_kind`/`beneficiary`/`amount`/`status` untouched.
 *
 * This is the same read-modify-write-via-`dev_setStorage` technique used elsewhere (e.g. `upgrade.ts`).
 */
async function setSpendTiming<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  assetHubClient: Client<TCustom, TInitStoragesPara>,
  spendIndex: number,
  timing: { validFrom?: number; expireAt?: number },
) {
  const spend = (await assetHubClient.api.query.treasury.spends(spendIndex)).unwrap()
  const spendJson = spend.toJSON() as Record<string, unknown>
  if (timing.validFrom !== undefined) spendJson.validFrom = timing.validFrom
  if (timing.expireAt !== undefined) spendJson.expireAt = timing.expireAt

  const spendsMeta = assetHubClient.api.query.treasury.spends.creator.meta
  const spendValueType = assetHubClient.api.registry.lookup.getTypeDef(spendsMeta.type.asMap.value).type
  const patchedSpend = assetHubClient.api.registry.createType(spendValueType, spendJson)

  const spendKey = assetHubClient.api.query.treasury.spends.key(spendIndex)
  await assetHubClient.api.rpc('dev_setStorage', [[spendKey, patchedSpend.toHex()]])
}

/**
 * Helper: Schedule a `spend`, produce the block that approves it, and return the resulting spend index.
 * Wraps the create → newBlock → read-index sequence common to most lifecycle tests.
 */
async function createApprovedSpend<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  assetHubClient: Client<TCustom, TInitStoragesPara>,
  spendAmount: bigint,
  origin: string = SPEND_ORIGIN,
  validFrom: number | null = null,
  assetKind: FrameSupportTokensFungibleUnionOfNativeOrWithId = ASSET_KIND,
): Promise<number> {
  await createSpendProposal(assetHubClient, spendAmount, origin, validFrom, assetKind)
  await assetHubClient.dev.newBlock()
  return await getSpendIndexFromEvent(assetHubClient, 'AssetSpendApproved')
}

/**
 * Helper: Creates and schedules a treasury spend proposal
 */
async function createSpendProposal<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  assetHubClient: Client<TCustom, TInitStoragesPara>,
  spendAmount: bigint,
  origin: string = SPEND_ORIGIN,
  validFrom: number | null = null,
  assetKind: FrameSupportTokensFungibleUnionOfNativeOrWithId = ASSET_KIND,
) {
  const spendTx = assetHubClient.api.tx.treasury.spend(assetKind, spendAmount, BENEFICIARY_LOCATION, validFrom)
  const hexSpendTx = spendTx.method.toHex()
  await scheduleInlineCallWithOrigin(
    assetHubClient,
    hexSpendTx,
    { Origins: origin },
    assetHubClient.config.properties.schedulerBlockProvider,
  )
}

/**
 * Helper: Verify that the AssetSpendApproved event was emitted
 */
async function verifySystemEventAssetSpendApproved<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await checkSystemEvents(assetHubClient, { section: 'treasury', method: 'AssetSpendApproved' })
    .redact({ redactKeys: /expireAt|validFrom|index|amount/ })
    .toMatchSnapshot('treasury spend approval events')
}

/**
 * Helper: create a spend, approve it in the next block, and assert it was stored as a `Pending` spend for
 * exactly `spendAmount` with the expected `[validFrom, validFrom + PayoutPeriod]` payout window. Returns
 * the spend index.
 *
 * This is the common opening shared by the basic / void / claim / check-status lifecycle tests.
 */
async function approveSpendAndVerify<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, spendAmount: bigint): Promise<number> {
  const initialSpendCount = await getSpendCount(assetHubClient)
  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount)

  // Verify that the AssetSpendApproved event was emitted and the spend count incremented by exactly one.
  await verifySystemEventAssetSpendApproved(assetHubClient)
  expect(await getSpendCount(assetHubClient)).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly.
  const spend = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spend.isSome).toBe(true)
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const payoutPeriod = assetHubClient.api.consts.treasury.payoutPeriod.toNumber()
  expect(spendData.expireAt.toNumber()).toBe(spendData.validFrom.toNumber() + payoutPeriod)

  return spendIndex
}

/**
 * Test: Propose and approve a spend of treasury funds
 *
 * Verifies that the treasury's foreign asset spending mechanism correctly processes spend proposals
 * and maintains proper state tracking. This test ensures that when authorized users create spend
 * proposals for foreign assets (like USDT on Asset Hub), the treasury system properly validates,
 * stores, and schedules these spends for execution.
 *
 * Test Structure:
 * 1. Create a treasury spend proposal for USDT on Asset Hub
 * 2. Verify the spend is stored correctly in treasury state
 * 3. Check that `AssetSpendApproved` event is emitted with correct data
 * 4. Validate spend count increment and proper indexing
 * 5. Confirm spend timing constraints (validFrom and expireAt periods)
 */
export async function treasurySpendBasicTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  // Creating, approving and verifying the spend's stored state is exactly what this test asserts.
  await approveSpendAndVerify(assetHubClient, spendAmount)
}

/**
 * Helper: Void a previously approved spend proposal
 */
async function voidApprovedSpendProposal<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, spendIndex: number) {
  const removeApprovedSpendTx = assetHubClient.api.tx.treasury.voidSpend(spendIndex)
  const hexRemoveApprovedSpendTx = removeApprovedSpendTx.method.toHex()
  await scheduleInlineCallWithOrigin(
    assetHubClient,
    hexRemoveApprovedSpendTx,
    { Origins: REJECT_ORIGIN },
    assetHubClient.config.properties.schedulerBlockProvider,
  )
}

/**
 * Helper: Verify that the AssetSpendVoided event was emitted
 */
async function verifySystemEventAssetSpendVoided<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await checkSystemEvents(assetHubClient, { section: 'treasury', method: 'AssetSpendVoided' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('treasury spend voided events')
}

/**
 * Test: Void a previously approved proposal
 *
 * Verifies that the treasury's spend voiding mechanism correctly cancels previously approved
 * spend proposals and properly cleans up associated state. This test ensures that authorized
 * users can cancel approved spends before they are executed, preventing unintended fund
 * disbursements and maintaining proper treasury governance controls.
 *
 * Test Structure:
 * 1. Create and approve a treasury spend proposal for USDT on Asset Hub
 * 2. Verify the spend is properly stored and approved
 * 3. Void the approved spend proposal using authorized origin
 * 4. Check that AssetSpendVoided event is emitted with correct data
 * 5. Confirm the spend is completely removed from treasury storage
 */
export async function voidApprovedTreasurySpendProposal<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  const spendIndex = await approveSpendAndVerify(assetHubClient, spendAmount)

  await assetHubClient.dev.newBlock()

  // Void the approved proposal
  await voidApprovedSpendProposal(assetHubClient, spendIndex)

  await assetHubClient.dev.newBlock()

  // Check that AssetSpendVoided event was emitted
  await verifySystemEventAssetSpendVoided(assetHubClient)

  // Verify the spend was removed from the storage
  const spendAfter = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spendAfter.isNone).toBe(true)
}

/**
 * Helper: submit a `payout` for `spendIndex`, signed by `signer`.
 *
 * Note `payout` is permissionless — the signer need not be the beneficiary; funds always go to the
 * beneficiary recorded on the spend.
 */
async function sendPayoutTx<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, spendIndex: number, signer: KeyringPair) {
  const payoutTx = assetHubClient.api.tx.treasury.payout(spendIndex)
  return await sendTransaction(payoutTx.signAsync(signer))
}

/**
 * Helper: Verify that the Paid event was emitted
 */
async function verifyEventPaid(events: { events: Promise<Codec | Codec[]> }) {
  await checkEvents(events, { section: 'treasury', method: 'Paid' })
    .redact({ redactKeys: /paymentId|index/ })
    .toMatchSnapshot('payout events')
}

/**
 * Test: Claim a spend
 *
 * Verifies that the treasury's spend claiming mechanism correctly processes approved spends
 * and properly updates the spend status. This test ensures that authorized users can claim
 * approved spends after the payout period has ended, ensuring proper fund disbursement and
 * tracking of successful transactions.
 *
 * Test Structure:
 * 1. Create and approve a treasury spend proposal for USDT on Asset Hub
 * 2. Verify the spend is properly stored and approved
 * 3. Claim the approved spend using Alice's account (beneficiary)
 * 4. Check that Paid event is emitted with correct data
 * 5. Confirm Alice's USDT balance increases by the spend amount on Asset Hub
 */
export async function claimTreasurySpend<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  const spendIndex = await approveSpendAndVerify(assetHubClient, spendAmount)

  const balanceAmountBefore = (
    await assetHubClient.api.query.system.account(testAccounts.alice.address)
  ).data.free.toBigInt()
  await assetHubClient.dev.newBlock()

  // `payout` is permissionless, so we sign with bob rather than the beneficiary (alice). The tx fee is then
  // charged to bob, which lets us assert alice received *exactly* the spend amount
  const payoutEvents = await sendPayoutTx(assetHubClient, spendIndex, testAccounts.bob)

  await assetHubClient.dev.newBlock()

  await verifyEventPaid(payoutEvents)

  const payoutIndex = await getSpendIndexFromEvent(assetHubClient, 'Paid')
  expect(payoutIndex).toBe(spendIndex)

  await assetHubClient.dev.newBlock()

  // Alice's balance increased by exactly the spend amount
  const balanceAmountAfter = (
    await assetHubClient.api.query.system.account(testAccounts.alice.address)
  ).data.free.toBigInt()
  expect(balanceAmountAfter - balanceAmountBefore).toBe(spendAmount)
}

async function verifyEventSpendProcessed(events: { events: Promise<Codec | Codec[]> }) {
  await checkEvents(events, { section: 'treasury', method: 'SpendProcessed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('spend processed events')
}

async function sendCheckStatusTx<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesAssetHub extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesAssetHub>, spendIndex: number) {
  const checkStatusTx = assetHubClient.api.tx.treasury.checkStatus(spendIndex)
  return await sendTransaction(checkStatusTx.signAsync(testAccounts.alice))
}

/**
 * Test: Check the status of a spend and remove it from the storage if processed
 *
 * Verifies that the treasury's spend status checking mechanism correctly processes approved spends
 * and properly updates the spend status. This test ensures that users can check the
 * status of a spend and remove it from the storage if processed.
 *
 * Test Structure:
 * 1. Create and approve a treasury spend proposal for USDT on Asset Hub
 * 2. Verify the spend is properly stored and approved
 * 3. Check the status of the spend and remove it from the storage if processed
 * 4. Verify that the SpendProcessed event was emitted
 * 5. Verify that the spend is removed from the storage
 */
export async function checkStatusOfTreasurySpend<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  const spendIndex = await approveSpendAndVerify(assetHubClient, spendAmount)

  const balanceAmountBefore = (
    await assetHubClient.api.query.system.account(testAccounts.alice.address)
  ).data.free.toBigInt()

  await assetHubClient.dev.newBlock()

  // Sign the (permissionless) payout with bob, not the beneficiary, so alice's balance reflects only the
  // spend amount and not a tx fee.
  const payoutEvents = await sendPayoutTx(assetHubClient, spendIndex, testAccounts.bob)

  await assetHubClient.dev.newBlock()

  await verifyEventPaid(payoutEvents)

  const payoutIndex = await getSpendIndexFromEvent(assetHubClient, 'Paid')
  expect(payoutIndex).toBe(spendIndex)

  await assetHubClient.dev.newBlock()

  // Alice's balance increased by exactly the spend amount.
  const balanceAmountAfter = (
    await assetHubClient.api.query.system.account(testAccounts.alice.address)
  ).data.free.toBigInt()
  expect(balanceAmountAfter - balanceAmountBefore).toBe(spendAmount)

  await assetHubClient.dev.newBlock()

  const checkStatusEvents = await sendCheckStatusTx(assetHubClient, spendIndex)

  await assetHubClient.dev.newBlock()

  // verify SpendProcessed event
  await verifyEventSpendProcessed(checkStatusEvents)

  // verify the spend is removed from the storage
  const spendAfterCheckStatus = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spendAfterCheckStatus.isNone).toBe(true)
}

/**
 * Test: Proposing a expired spend emits `SpendExpired` error
 *
 * Verifies that the treasury's spend proposal mechanism correctly processes expired spends
 * and emits `SpendExpired` error.
 *
 * Test Structure:
 * 1. Create a spend proposal with a valid from that is in the past i.e expired
 * 2. Verify that the `SpendExpired` error is emitted on the dispatched event
 */

export async function proposeExpiredSpend<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER
  const currentBlockNumber = await assetHubClient.api.query.system.number()
  const payoutPeriod = assetHubClient.api.consts.treasury.payoutPeriod.toNumber()
  const validFrom = currentBlockNumber.toNumber() - payoutPeriod - 1 // subtracting any number to ensure that the spend is expired
  await createSpendProposal(assetHubClient, spendAmount, SPEND_ORIGIN, validFrom)

  await assetHubClient.dev.newBlock()

  // The spend is already expired at creation (`expire_at <= now`), so the scheduled `spend` call
  // dispatches a `SpendExpired` error.
  await assertScheduledCallError(assetHubClient, assetHubClient.api.errors.treasury.SpendExpired)
}

/**
 * Test: Smalltipper trying to spend more than the origin allows emits `InsufficientPermission` error
 *
 * Verifies that the treasury's spend proposal mechanism correctly processes smalltipper trying to spend more than the origin allows
 * and emits `InsufficientPermission` error.
 *
 * Test Structure:
 * 1. Create a spend proposal with `SmallTipper` origin which does not have permission to spend the spendAmount
 * 2. Verify that the `InsufficientPermission` error is emitted on the dispatched event
 */
export async function smalltipperTryingToSpendMoreThanTheOriginAllows<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const largeSpendAmount = existentialDeposit * LARGE_SPEND_AMOUNT_MULTIPLIER
  await createSpendProposal(assetHubClient, largeSpendAmount, SMALL_TIPPER_ORIGIN) // SmallTipper does not have permission to spend large amounts

  await assetHubClient.dev.newBlock()

  // SmallTipper's `SpendOrigin` max is below the requested amount, so the scheduled `spend` call
  // dispatches an `InsufficientPermission` error.
  await assertScheduledCallError(assetHubClient, assetHubClient.api.errors.treasury.InsufficientPermission)
}

/**
 * Test: A deferred spend cannot be paid before `valid_from`, but can be once that block is reached.
 *
 * Exercises the `valid_from` gate end-to-end:
 * 1. Approve a spend, then postdate its `valid_from` into the future.
 * 2. `payout` while the gate is closed → `EarlyPayout`.
 * 3. Move `valid_from` back to the present (simulating the chain reaching it) and `payout` → `Paid`,
 *    with the beneficiary's balance increasing.
 *
 * (Backdating/postdating via storage avoids advancing a full `PayoutPeriod` of blocks — see `setSpendTiming`.)
 */
export async function deferredSpendBecomesClaimableTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER
  const payoutPeriod = assetHubClient.api.consts.treasury.payoutPeriod.toNumber()

  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount)
  const approvedNow = (await assetHubClient.api.query.treasury.spends(spendIndex)).unwrap().validFrom.toNumber()

  // Postdate `valid_from` far into the future so the spend is not yet claimable.
  const futureValidFrom = approvedNow + 10_000_000
  await setSpendTiming(assetHubClient, spendIndex, {
    validFrom: futureValidFrom,
    expireAt: futureValidFrom + payoutPeriod,
  })

  // Gate closed: payout before `valid_from` fails with `EarlyPayout`.
  await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)
  await assetHubClient.dev.newBlock()
  await assertSignedExtrinsicError(assetHubClient, assetHubClient.api.errors.treasury.EarlyPayout)

  // Gate open: move `valid_from` to the present (with `expire_at` still in the future) and claim.
  await setSpendTiming(assetHubClient, spendIndex, {
    validFrom: approvedNow,
    expireAt: approvedNow + payoutPeriod,
  })

  const balanceBefore = (await assetHubClient.api.query.system.account(testAccounts.alice.address)).data.free.toBigInt()

  const payoutEvents = await sendPayoutTx(assetHubClient, spendIndex, testAccounts.bob)
  await assetHubClient.dev.newBlock()
  await verifyEventPaid(payoutEvents)

  await assetHubClient.dev.newBlock()
  const balanceAfter = (await assetHubClient.api.query.system.account(testAccounts.alice.address)).data.free.toBigInt()
  expect(balanceAfter - balanceBefore).toBe(spendAmount)
}

/**
 * Test: `check_status` cleans up an expired spend that was never paid out.
 *
 * Distinct from the "claim then process" flow (H4): here the spend is approved, never claimed, and made to
 * expire. `check_status` should then take the `now > expire_at && !Attempted` branch — removing the spend
 * and emitting `SpendProcessed` (with the fee refunded, `Pays::No`).
 */
export async function checkStatusRemovesExpiredSpendTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount)

  // Expire the spend in place while it is still `Pending` (never claimed).
  await setSpendTiming(assetHubClient, spendIndex, { expireAt: 1 })

  const checkStatusEvents = await sendCheckStatusTx(assetHubClient, spendIndex)
  await assetHubClient.dev.newBlock()

  await verifyEventSpendProcessed(checkStatusEvents)

  const spendAfter = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spendAfter.isNone).toBe(true)
}

/**
 * Test: Full lifecycle of a USDT (assets-pallet asset id 1984) spend, asserting total issuance is preserved.
 *
 * Mirrors the native lifecycle (approve → payout → check_status) but spends a non-native asset, asserting
 * the beneficiary's *assets-pallet* USDT balance increases. Setup ensures the treasury pot holds USDT and
 * that an asset-rate conversion exists (required by the pallet's `BalanceConverter` permission check).
 *
 * The AH treasury pays via `PayOverXcm`, so the payout runs through the XCM executor's fungible-deposit
 * path. This test additionally asserts USDT **total issuance on Asset Hub is unchanged** across the payout,
 * validating the imbalance-tracking introduced by polkadot-sdk#10384 (the beneficiary's credit is balanced
 * by the treasury's debit, not an unaccounted mint). See `treasury_xcm_imbalance_test.md`.
 */
export async function usdtSpendLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Fund the treasury pot with USDT so the paymaster has funds to disburse.
  const treasuryAccount = encodeAddress(
    assetHubClient.api.consts.treasury.potAccount.toHex(),
    assetHubClient.config.properties.addressEncoding,
  )
  await assetHubClient.dev.setStorage({
    Assets: {
      account: [[[USDT_ASSET_ID, treasuryAccount], { balance: 1_000_000n * 1_000_000n }]], // 1,000,000 USDT
    },
  })

  // The pallet converts the asset amount to the native asset to check the spend origin's limit; this
  // requires an asset-rate entry for USDT. Create one if the forked state doesn't already have it.
  const existingRate = await assetHubClient.api.query.assetRate.conversionRateToNative(USDT_ASSET_KIND)
  if (existingRate.isNone) {
    const createRateTx = assetHubClient.api.tx.assetRate.create(USDT_ASSET_KIND, '1000000000000000000') // 1.0
    await scheduleInlineCallWithOrigin(
      assetHubClient,
      createRateTx.method.toHex(),
      { system: 'Root' },
      assetHubClient.config.properties.schedulerBlockProvider,
    )
    await assetHubClient.dev.newBlock()
  }

  const spendAmount = 100n * 1_000_000n // 100 USDT (6 decimals)
  const balanceBefore = await getUsdtBalance(assetHubClient, testAccounts.alice.address)
  // Capture USDT total issuance before the payout. The AH treasury pays via `PayOverXcm`, so the payout
  // runs through the XCM executor's fungible-deposit path — the code rewritten by polkadot-sdk#10384 to
  // track imbalances in holding. A correct payout transfers USDT from the treasury to the beneficiary
  // without changing the asset's total issuance.
  const issuanceBefore = await getUsdtTotalIssuance(assetHubClient)

  // Approve the USDT spend.
  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount, SPEND_ORIGIN, null, USDT_ASSET_KIND)
  await verifySystemEventAssetSpendApproved(assetHubClient)

  // Claim it.
  const payoutEvents = await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)
  await assetHubClient.dev.newBlock()
  await verifyEventPaid(payoutEvents)
  // Assert the payout actually settled (a `Paid` event for this spend), so the test can't pass on a
  // no-op payout that left the spend `Pending`.
  const paidIndex = await getSpendIndexFromEvent(assetHubClient, 'Paid')
  expect(paidIndex).toBe(spendIndex)

  // Beneficiary's USDT balance increases by the spent amount.
  await assetHubClient.dev.newBlock()
  const balanceAfter = await getUsdtBalance(assetHubClient, testAccounts.alice.address)
  expect(balanceAfter - balanceBefore).toBe(spendAmount)

  // The XCM-executed payout must not change USDT total issuance on Asset Hub: the beneficiary's gain is
  // matched by the treasury's loss, not by an unbalanced mint (validates polkadot-sdk#10384).
  const issuanceAfter = await getUsdtTotalIssuance(assetHubClient)
  expect(issuanceAfter).toBe(issuanceBefore)

  // Finalize: check_status removes the processed spend.
  const checkStatusEvents = await sendCheckStatusTx(assetHubClient, spendIndex)
  await assetHubClient.dev.newBlock()
  await verifyEventSpendProcessed(checkStatusEvents)
  const spendAfter = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spendAfter.isNone).toBe(true)
}

/**
 * Test: `payout` of a non-existent spend index → `InvalidIndex`.
 */
export async function payoutInvalidIndexTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const nonExistentIndex = (await getSpendCount(assetHubClient)) + 1000
  await sendPayoutTx(assetHubClient, nonExistentIndex, testAccounts.alice)
  await assetHubClient.dev.newBlock()
  await assertSignedExtrinsicError(assetHubClient, assetHubClient.api.errors.treasury.InvalidIndex)
}

/**
 * Test: `payout` of a spend whose `expire_at` has passed → `SpendExpired`.
 */
export async function payoutExpiredSpendTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount)

  // Expire the spend (keeping `valid_from` in the past so the `EarlyPayout` guard passes first).
  await setSpendTiming(assetHubClient, spendIndex, { expireAt: 1 })

  await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)
  await assetHubClient.dev.newBlock()
  await assertSignedExtrinsicError(assetHubClient, assetHubClient.api.errors.treasury.SpendExpired)
}

/**
 * Test: A second `payout` of an already-claimed spend → `AlreadyAttempted`.
 */
export async function doublePayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount)

  // First payout succeeds and sets the spend's status to `Attempted`.
  await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)
  await assetHubClient.dev.newBlock()
  const spend = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spend.unwrap().status.isAttempted).toBe(true)

  // Second payout of the same spend is rejected.
  await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)
  await assetHubClient.dev.newBlock()
  await assertSignedExtrinsicError(assetHubClient, assetHubClient.api.errors.treasury.AlreadyAttempted)
}

/**
 * Test: `void_spend` of a non-existent spend index → `InvalidIndex`.
 */
export async function voidInvalidIndexTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const nonExistentIndex = (await getSpendCount(assetHubClient)) + 1000
  const voidTx = assetHubClient.api.tx.treasury.voidSpend(nonExistentIndex)
  await scheduleInlineCallWithOrigin(
    assetHubClient,
    voidTx.method.toHex(),
    { Origins: REJECT_ORIGIN },
    assetHubClient.config.properties.schedulerBlockProvider,
  )
  await assetHubClient.dev.newBlock()
  await assertScheduledCallError(assetHubClient, assetHubClient.api.errors.treasury.InvalidIndex)
}

/**
 * Test: `void_spend` of a spend that has already been paid out → `AlreadyAttempted`.
 */
export async function voidAfterPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount)

  // Claim it so its status becomes `Attempted`.
  await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)
  await assetHubClient.dev.newBlock()
  expect((await assetHubClient.api.query.treasury.spends(spendIndex)).unwrap().status.isAttempted).toBe(true)

  // Voiding an already-attempted spend is rejected.
  await voidApprovedSpendProposal(assetHubClient, spendIndex)
  await assetHubClient.dev.newBlock()
  await assertScheduledCallError(assetHubClient, assetHubClient.api.errors.treasury.AlreadyAttempted)
}

/**
 * Test: `check_status` of a non-existent spend index → `InvalidIndex`.
 */
export async function checkStatusInvalidIndexTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const nonExistentIndex = (await getSpendCount(assetHubClient)) + 1000
  await sendCheckStatusTx(assetHubClient, nonExistentIndex)
  await assetHubClient.dev.newBlock()
  await assertSignedExtrinsicError(assetHubClient, assetHubClient.api.errors.treasury.InvalidIndex)
}

/**
 * Test: `check_status` of a still-pending, never-claimed, unexpired spend → `NotAttempted`.
 */
export async function checkStatusNotAttemptedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  // A freshly approved spend is `Pending` (not yet attempted) and not expired.
  const spendIndex = await createApprovedSpend(assetHubClient, spendAmount)

  await sendCheckStatusTx(assetHubClient, spendIndex)
  await assetHubClient.dev.newBlock()
  await assertSignedExtrinsicError(assetHubClient, assetHubClient.api.errors.treasury.NotAttempted)
}

/**
 * Helper: USDT (assets pallet) total issuance on Asset Hub, `0n` if the asset is absent.
 */
async function getUsdtTotalIssuance<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>): Promise<bigint> {
  const asset = await assetHubClient.api.query.assets.asset(USDT_ASSET_ID)
  return asset.isNone ? 0n : asset.unwrap().supply.toBigInt()
}

/**
 * Success-path sub-suite: the treasury spend lifecycle behaves as specified.
 *
 * Clients are passed as getter thunks so the shared `let`-bound clients (assigned in the root suite's
 * `beforeAll`) are resolved lazily at test-run time.
 */
function treasurySuccessTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(getAssetHubClient: () => Client<TCustom, TInitStoragesPara>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Success',
    children: [
      {
        kind: 'test',
        label: 'Propose and approve a spend of treasury funds',
        testFn: async () => await treasurySpendBasicTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Void previously approved spend',
        testFn: async () => await voidApprovedTreasurySpendProposal(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Claim a spend',
        testFn: async () => await claimTreasurySpend(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Check status of a spend and remove it from the storage if processed',
        testFn: async () => await checkStatusOfTreasurySpend(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Deferred spend cannot be paid before valid_from but can be paid after',
        testFn: async () => await deferredSpendBecomesClaimableTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Check status cleans up an expired, never-paid spend',
        testFn: async () => await checkStatusRemovesExpiredSpendTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'USDT spend lifecycle preserves total issuance (approve, payout, check status)',
        testFn: async () => await usdtSpendLifecycleTest(getAssetHubClient()),
      },
    ],
  }
}

/**
 * Failure sub-suite: each guarded condition in the spend lifecycle rejects with its specific module error.
 */
function treasuryFailureTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(getAssetHubClient: () => Client<TCustom, TInitStoragesPara>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Failure',
    children: [
      {
        kind: 'test',
        label: 'Proposing an expired spend emits SpendExpired error',
        testFn: async () => await proposeExpiredSpend(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Smalltipper trying to spend more than the origin allows emits InsufficientPermission error',
        testFn: async () => await smalltipperTryingToSpendMoreThanTheOriginAllows(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Payout of a non-existent spend emits InvalidIndex error',
        testFn: async () => await payoutInvalidIndexTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Payout of an expired spend emits SpendExpired error',
        testFn: async () => await payoutExpiredSpendTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Second payout of an already-claimed spend emits AlreadyAttempted error',
        testFn: async () => await doublePayoutTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Voiding a non-existent spend emits InvalidIndex error',
        testFn: async () => await voidInvalidIndexTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Voiding an already-claimed spend emits AlreadyAttempted error',
        testFn: async () => await voidAfterPayoutTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Check status of a non-existent spend emits InvalidIndex error',
        testFn: async () => await checkStatusInvalidIndexTest(getAssetHubClient()),
      },
      {
        kind: 'test',
        label: 'Check status of a pending, never-claimed spend emits NotAttempted error',
        testFn: async () => await checkStatusNotAttemptedTest(getAssetHubClient()),
      },
    ],
  }
}

export function baseTreasuryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  ahChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: TestConfig,
): RootTestTree {
  let relayClient!: Client<TCustom, TInitStoragesRelay>
  let assetHubClient!: Client<TCustom, TInitStoragesPara>
  let restoreSnapshot: () => Promise<void>
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[relayClient, assetHubClient] = await createNetworks(relayChain, ahChain)
      restoreSnapshot = captureSnapshot(relayClient, assetHubClient)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      for (const c of [relayClient, assetHubClient]) {
        const blockNumber = (await c.api.rpc.chain.getHeader()).number.toNumber()
        await c.dev.setHead(blockNumber)
      }
    },
    afterAll: async () => {
      for (const c of [relayClient, assetHubClient]) {
        await c.api.disconnect().catch(() => {})
        await c.teardown().catch(() => {})
      }
    },
    children: [treasurySuccessTests(() => assetHubClient), treasuryFailureTests(() => assetHubClient)],
  }
}
