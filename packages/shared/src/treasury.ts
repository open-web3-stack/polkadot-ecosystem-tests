import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import type { FrameSupportTokensFungibleUnionOfNativeOrWithId, XcmVersionedLocation } from '@polkadot/types/lookup'
import type { Codec } from '@polkadot/types/types'

import { assert, expect } from 'vitest'

import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'
import type { RootTestTree } from './types.js'

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
  const [event] = (await assetHubClient.api.query.system.events()).filter(
    ({ event }: any) => event.section === 'treasury' && event.method === eventType,
  )
  expect(event).toBeTruthy()
  assert(assetHubClient.api.events.treasury[eventType].is(event.event))
  return event.event.data.index.toNumber()
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
  testConfig: TestConfig,
  origin: string = SPEND_ORIGIN,
  validFrom: number | null = null,
) {
  const spendTx = assetHubClient.api.tx.treasury.spend(ASSET_KIND, spendAmount, BENEFICIARY_LOCATION, validFrom)
  const hexSpendTx = spendTx.method.toHex()
  await scheduleInlineCallWithOrigin(assetHubClient, hexSpendTx, { Origins: origin }, testConfig.blockProvider)
}

/**
 * Helper: Verify that the AssetSpendApproved event was emitted
 */
async function verifySystemEventAssetSpendApproved<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>) {
  await checkSystemEvents(assetHubClient, { section: 'treasury', method: 'AssetSpendApproved' })
    .redact({ redactKeys: /expireAt|validFrom|index|data/ })
    .toMatchSnapshot('treasury spend approval events')
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
>(ahChain: Chain<TCustom, TInitStoragesPara>, testConfig: TestConfig) {
  const [assetHubClient] = await setupNetworks(ahChain)

  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Get initial spend count
  const initialSpendCount = await getSpendCount(assetHubClient)

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  await createSpendProposal(assetHubClient, spendAmount, testConfig) // validFrom will default to null and the spend call will take current block number as validFrom block number

  await assetHubClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(assetHubClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(assetHubClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(assetHubClient, 'AssetSpendApproved')
  const spend = await assetHubClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const validFrom = spendData.validFrom.toNumber()
  const payoutPeriod = assetHubClient.api.consts.treasury.payoutPeriod.toNumber()
  expect(spendData.expireAt.toNumber()).toBe(validFrom + payoutPeriod)

  await assetHubClient.teardown()
}

/**
 * Helper: Void a previously approved spend proposal
 */
async function voidApprovedSpendProposal<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, spendIndex: number, testConfig: TestConfig) {
  const removeApprovedSpendTx = assetHubClient.api.tx.treasury.voidSpend(spendIndex)
  const hexRemoveApprovedSpendTx = removeApprovedSpendTx.method.toHex()
  await scheduleInlineCallWithOrigin(
    assetHubClient,
    hexRemoveApprovedSpendTx,
    { Origins: REJECT_ORIGIN },
    testConfig.blockProvider,
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
>(ahChain: Chain<TCustom, TInitStoragesPara>, testConfig: TestConfig) {
  const [assetHubClient] = await setupNetworks(ahChain)

  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Get initial spend count
  const initialSpendCount = await getSpendCount(assetHubClient)

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  await createSpendProposal(assetHubClient, spendAmount, testConfig)

  await assetHubClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(assetHubClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(assetHubClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(assetHubClient, 'AssetSpendApproved')
  const spend = await assetHubClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const validFrom = spendData.validFrom.toNumber()
  const payoutPeriod = assetHubClient.api.consts.treasury.payoutPeriod.toNumber()
  expect(spendData.expireAt.toNumber()).toBe(validFrom + payoutPeriod)

  await assetHubClient.dev.newBlock()

  // Void the approved proposal
  await voidApprovedSpendProposal(assetHubClient, spendIndex, testConfig)

  await assetHubClient.dev.newBlock()

  // Check that AssetSpendVoided event was emitted
  await verifySystemEventAssetSpendVoided(assetHubClient)

  // Verify the spend was removed from the storage
  const spendAfter = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spendAfter.isNone).toBe(true)

  await assetHubClient.teardown()
}

/**
 *  Helper: Create a function sendPayoutTx by the beneficiary
 */
async function sendPayoutTx<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, spendIndex: number, beneficiary: KeyringPair) {
  const payoutTx = assetHubClient.api.tx.treasury.payout(spendIndex)
  return await sendTransaction(payoutTx.signAsync(beneficiary))
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
>(ahChain: Chain<TCustom, TInitStoragesPara>, testConfig: TestConfig) {
  const [assetHubClient] = await setupNetworks(ahChain)

  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Get initial spend count
  const initialSpendCount = await getSpendCount(assetHubClient)

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER
  await createSpendProposal(assetHubClient, spendAmount, testConfig)

  await assetHubClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(assetHubClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(assetHubClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(assetHubClient, 'AssetSpendApproved')
  const spend = await assetHubClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const balance = await assetHubClient.api.query.system.account(testAccounts.alice.address)
  const balanceAmountBefore = balance.data.free.toBigInt()
  await assetHubClient.dev.newBlock()

  // Claim the spend by the beneficiary i.e alice
  const payoutEvents = await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)

  await assetHubClient.dev.newBlock()

  await verifyEventPaid(payoutEvents)

  const payoutIndex = await getSpendIndexFromEvent(assetHubClient, 'Paid')
  expect(payoutIndex).toBe(spendIndex)

  await assetHubClient.dev.newBlock()

  // ensure that Alice's balance is increased
  const balanceAfter = await assetHubClient.api.query.system.account(testAccounts.alice.address)
  const balanceAmountAfter = balanceAfter.data.free.toBigInt()
  expect(balanceAmountAfter - balanceAmountBefore).toBeGreaterThan(0n)

  await assetHubClient.teardown()
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
>(ahChain: Chain<TCustom, TInitStoragesPara>, testConfig: TestConfig) {
  const [assetHubClient] = await setupNetworks(ahChain)

  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Get initial spend count
  const initialSpendCount = await getSpendCount(assetHubClient)

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  await createSpendProposal(assetHubClient, spendAmount, testConfig)

  await assetHubClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(assetHubClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(assetHubClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(assetHubClient, 'AssetSpendApproved')
  const spend = await assetHubClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const balanceBefore = await assetHubClient.api.query.system.account(testAccounts.alice.address)
  const balanceAmountBefore = balanceBefore.data.free.toBigInt()

  await assetHubClient.dev.newBlock()

  // Claim the spend by the beneficiary i.e alice
  const payoutEvents = await sendPayoutTx(assetHubClient, spendIndex, testAccounts.alice)

  await assetHubClient.dev.newBlock()

  await verifyEventPaid(payoutEvents)

  const payoutIndex = await getSpendIndexFromEvent(assetHubClient, 'Paid')
  expect(payoutIndex).toBe(spendIndex)

  await assetHubClient.dev.newBlock()

  // Ensure that Alice's balance is increased
  const balanceAfter = await assetHubClient.api.query.system.account(testAccounts.alice.address)
  const balanceAmountAfter = balanceAfter.data.free.toBigInt()
  expect(balanceAmountAfter - balanceAmountBefore).toBeGreaterThan(0n)

  await assetHubClient.dev.newBlock()

  const checkStatusEvents = await sendCheckStatusTx(assetHubClient, spendIndex)

  await assetHubClient.dev.newBlock()

  // verify SpendProcessed event
  await verifyEventSpendProcessed(checkStatusEvents)

  // verify the spend is removed from the storage
  const spendAfterCheckStatus = await assetHubClient.api.query.treasury.spends(spendIndex)
  expect(spendAfterCheckStatus.isNone).toBe(true)

  await assetHubClient.teardown()
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
>(ahChain: Chain<TCustom, TInitStoragesPara>, testConfig: TestConfig) {
  const [assetHubClient] = await setupNetworks(ahChain)

  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER
  const currentBlockNumber = await assetHubClient.api.query.system.number()
  const payoutPeriod = assetHubClient.api.consts.treasury.payoutPeriod.toNumber()
  const validFrom = currentBlockNumber.toNumber() - payoutPeriod - 1 // subtracting any number to ensure that the spend is expired
  await createSpendProposal(assetHubClient, spendAmount, testConfig, SPEND_ORIGIN, validFrom)

  await assetHubClient.dev.newBlock()

  // check the result of dispatched event
  const events = await assetHubClient.api.query.system.events()
  // Find the Dispatched event from scheduler
  const dispatchedEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'Dispatched'
  })

  assert(dispatchedEvents.length > 0)
  // the spend is expired, at least one of the dispatched events should be an error with SpendExpired
  let foundSpendExpiredError = false
  for (const dispatchedEvent of dispatchedEvents) {
    assert(assetHubClient.api.events.scheduler.Dispatched.is(dispatchedEvent.event))
    const dispatchedData = dispatchedEvent.event.data

    // if the result is an error
    if (dispatchedData.result.isErr) {
      const dispatchError = dispatchedData.result.asErr
      if (dispatchError.isModule) {
        // Check if this is the SpendExpired error
        if (assetHubClient.api.errors.treasury.SpendExpired.is(dispatchError.asModule)) {
          foundSpendExpiredError = true
        }
      }
    }
  }
  // Ensure at least one error was SpendExpired
  assert(foundSpendExpiredError, 'Expected at least one Dispatched event to have a SpendExpired error')
  await assetHubClient.teardown()
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
>(ahChain: Chain<TCustom, TInitStoragesPara>, testConfig: TestConfig) {
  const [assetHubClient] = await setupNetworks(ahChain)

  // Setup test accounts
  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // Create a spend proposal
  const existentialDeposit = assetHubClient.api.consts.balances.existentialDeposit.toBigInt()
  const largeSpendAmount = existentialDeposit * LARGE_SPEND_AMOUNT_MULTIPLIER
  await createSpendProposal(assetHubClient, largeSpendAmount, testConfig, SMALL_TIPPER_ORIGIN) // SmallTipper does not have permission to spend large amounts

  await assetHubClient.dev.newBlock()

  // check the result of dispatched event
  const events = await assetHubClient.api.query.system.events()
  // Find the Dispatched event from scheduler
  const dispatchedEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'Dispatched'
  })

  assert(dispatchedEvents.length > 0)
  let foundInsufficientPermissionError = false
  // check if at least one of the dispatched events is an error with InsufficientPermission
  for (const dispatchedEvent of dispatchedEvents) {
    assert(assetHubClient.api.events.scheduler.Dispatched.is(dispatchedEvent.event))
    const dispatchedData = dispatchedEvent.event.data

    // if the result is an error
    if (dispatchedData.result.isErr) {
      const dispatchError = dispatchedData.result.asErr
      assert(dispatchError.isModule)
      if (assetHubClient.api.errors.treasury.InsufficientPermission.is(dispatchError.asModule)) {
        foundInsufficientPermissionError = true
      }
    }
  }

  // Ensure at least one error was InsufficientPermission
  assert(
    foundInsufficientPermissionError,
    'Expected at least one Dispatched event to have a InsufficientPermission error',
  )

  await assetHubClient.teardown()
}

/**
 * Test: Check treasury payouts which are already approved can be paid
 *
 * Verifies that the treasury's payout mechanism correctly processes already approved spends
 * and properly disburses funds to beneficiaries. This test ensures that approved treasury
 * spends can be successfully paid out
 *
 * Test Structure:
 * 1. Get all the spends which are pending or failed and is neither expired nor early payout
 * 2. Call payout tx for each pending or failed spend
 * 3. Verify the Paid event is emitted
 * 4. Verify the spend status is attempted
 */
export async function checkTreasuryPayoutsWhichAreAlreadyApprovedCanBePaid<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, ahChain: Chain<TCustom, TInitStoragesPara>) {
  const [assetHubClient, relayClient] = await setupNetworks(ahChain, relayChain)

  await setupTestAccounts(assetHubClient, ['alice', 'bob'])

  // get all the spends
  const spends = await assetHubClient.api.query.treasury.spends.entries()

  // get current relay chain block number
  const currentRelayChainBlockNumber = (await relayClient.api.query.system.number()).toNumber()

  // filter those spends which are pending or failed and is neither expired nor early payout
  const pendingOrFailedSpends = spends.filter((spend) => {
    const spendData = spend[1]?.unwrap()
    return (
      (spendData?.status.isPending || spendData?.status.isFailed) && // not pending or failed
      spendData?.validFrom.toNumber() < currentRelayChainBlockNumber && //not early payout
      spendData?.expireAt.toNumber() > currentRelayChainBlockNumber // not expired
    )
  })

  await assetHubClient.dev.newBlock()

  const spendIndices: number[] = []

  // call payout tx for each pending or failed spend
  for (const spend of pendingOrFailedSpends) {
    const spendIndex = spend[0].toHuman?.() as number
    spendIndices.push(spendIndex)
    const payoutTx = assetHubClient.api.tx.treasury.payout(spendIndex)
    await sendTransaction(payoutTx.signAsync(testAccounts.alice))

    await assetHubClient.dev.newBlock()

    // verify the Paid event is emitted
    const treasuryEvents = await assetHubClient.api.query.system.events()
    const paidEvent = treasuryEvents.find((record) => {
      const { event } = record
      return event.section === 'treasury' && event.method === 'Paid'
    })
    assert(paidEvent)
    assert(assetHubClient.api.events.treasury.Paid.is(paidEvent.event))
  }

  // verify the spends status is attempted
  for (const spendIndex of spendIndices) {
    const spend = await assetHubClient.api.query.treasury.spends(spendIndex)
    expect(spend?.unwrap()?.status.isAttempted).toBe(true)
  }

  // call check_status tx for each spend
  for (const spendIndex of spendIndices) {
    const checkStatusEvents = await sendCheckStatusTx(assetHubClient, spendIndex)
    await assetHubClient.dev.newBlock()
    await verifyEventSpendProcessed(checkStatusEvents)

    // verify the spend is removed from the storage
    const spendAfterCheckStatus = await assetHubClient.api.query.treasury.spends(spendIndex)
    expect(spendAfterCheckStatus.isNone).toBe(true)
  }

  await assetHubClient.teardown()
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
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      // yarn test treasury -t "Propose and approve a spend of treasury funds"
      {
        kind: 'test',
        label: 'Propose and approve a spend of treasury funds',
        testFn: async () => await treasurySpendBasicTest(ahChain, testConfig),
      },
      {
        kind: 'test',
        label: 'Void previously approved spend',
        testFn: async () => await voidApprovedTreasurySpendProposal(ahChain, testConfig),
      },
      {
        kind: 'test',
        label: 'Claim a spend',
        testFn: async () => await claimTreasurySpend(ahChain, testConfig),
      },
      {
        kind: 'test',
        label: 'Check status of a spend and remove it from the storage if processed',
        testFn: async () => await checkStatusOfTreasurySpend(ahChain, testConfig),
      },
      {
        kind: 'test',
        label: 'Proposing a expired spend emits SpendExpired error',
        testFn: async () => await proposeExpiredSpend(ahChain, testConfig),
      },
      {
        kind: 'test',
        label: 'Smalltipper trying to spend more than the origin allows emits InsufficientPermission error',
        testFn: async () => await smalltipperTryingToSpendMoreThanTheOriginAllows(ahChain, testConfig),
      },
      {
        kind: 'test',
        label: 'Check treasury payouts which are already approved can be paid',
        testFn: async () => await checkTreasuryPayoutsWhichAreAlreadyApprovedCanBePaid(relayChain, ahChain),
      },
    ],
  }
}
