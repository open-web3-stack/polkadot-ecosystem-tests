import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import type { FrameSupportTokensFungibleUnionOfNativeOrWithId, XcmVersionedLocation } from '@polkadot/types/lookup'
import type { Codec } from '@polkadot/types/types'

import { assert, expect } from 'vitest'

//import { logAllEvents } from './helpers/helper_functions.js'
import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// Origins
const REJECT_ORIGIN = 'Treasurer'
const SPEND_ORIGIN = 'BigSpender'

// initial funding balance for accounts
const TEST_ACCOUNT_BALANCE_MULTIPLIER = 10000n // 10,000x existential deposit

const SPEND_AMOUNT_MULTIPLIER = 100n // 100x existential deposit

// AssetHub parachain ID
const ASSET_HUB_PARA_ID = 1000

// Assets pallet ID
const ASSETS_PALLET_ID = 50

// USDT asset ID
const USDT_ID = 1984

const ASSET_KIND = {
  v4: {
    location: {
      parents: 0,
      interior: {
        x1: [
          {
            parachain: ASSET_HUB_PARA_ID,
          },
        ],
      },
    },
    assetId: {
      parents: 0,
      interior: {
        x2: [
          {
            palletInstance: ASSETS_PALLET_ID,
          },
          {
            generalIndex: USDT_ID,
          },
        ],
      },
    },
  },
} as unknown as FrameSupportTokensFungibleUnionOfNativeOrWithId

// Beneficiary location(alice) for the treasury spend
const BENEFICIARY_LOCATION = {
  v4: {
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
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>): Promise<number> {
  return (await relayClient.api.query.treasury.spendCount()).toNumber()
}

async function getSpendIndexFromEvent<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>, eventType: 'AssetSpendApproved' | 'Paid'): Promise<number> {
  const [event] = (await relayClient.api.query.system.events()).filter(
    ({ event }: any) => event.section === 'treasury' && event.method === eventType,
  )
  expect(event).toBeTruthy()
  assert(relayClient.api.events.treasury[eventType].is(event.event))
  return event.event.data.index.toNumber()
}

/**
 * Test that a foreign asset spend from the Relay treasury is reflected on the AssetHub.
 *
 * 1. Approve a spend from the Relay treasury
 * 2. Payout the spend from the Relay treasury
 * 3. Check that the spend shows in the AssetHub
 */
export async function treasurySpendForeignAssetTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, ahChain: Chain<TCustom, TInitStoragesPara>) {
  const [relayClient, assetHubClient] = await setupNetworks(relayChain, ahChain)

  await relayClient.dev.setStorage({
    System: {
      account: [
        // give Alice some DOTs so that she can sign a payout transaction.
        [[testAccounts.alice.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })
  const ASSET_HUB_PARA_ID = 1000
  const ASSETS_PALLET_ID = 50
  const USDT_ID = 1984
  const balanceBefore = await assetHubClient.api.query.assets.account(USDT_ID, testAccounts.alice.address)

  // amount is encoded into the call
  const amount = 123123123123n
  const assetKind = {
    v4: {
      location: {
        parents: 0,
        interior: {
          x1: [
            {
              parachain: ASSET_HUB_PARA_ID,
            },
          ],
        },
      },
      assetId: {
        parents: 0,
        interior: {
          x2: [
            {
              palletInstance: ASSETS_PALLET_ID,
            },
            {
              generalIndex: USDT_ID,
            },
          ],
        },
      },
    },
  } as unknown as FrameSupportTokensFungibleUnionOfNativeOrWithId
  const beneficiary = {
    v4: {
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
  } as unknown as XcmVersionedLocation
  // validFrom - null, which means immediately.
  const call = relayClient.api.tx.treasury.spend(assetKind, amount, beneficiary, null)
  const hexCall = call.method.toHex()
  await scheduleInlineCallWithOrigin(relayClient, hexCall, { Origins: 'BigSpender' })
  await relayClient.dev.newBlock()
  await checkSystemEvents(relayClient, { section: 'treasury', method: 'AssetSpendApproved' })
    // values (e.g. index) inside data increase over time,
    // PET framework often rounds them.
    // Tests will be flaky if we don't redact them.
    .redact({
      redactKeys: /expireAt|validFrom|index/,
      number: false,
    })
    .toMatchSnapshot('treasury spend approval events')

  // filter events to find an index to payout
  const [assetSpendApprovedEvent] = (await relayClient.api.query.system.events()).filter(
    ({ event }) => event.section === 'treasury' && event.method === 'AssetSpendApproved',
  )
  expect(assetSpendApprovedEvent).toBeDefined()
  assert(relayClient.api.events.treasury.AssetSpendApproved.is(assetSpendApprovedEvent.event))
  const spendIndex = assetSpendApprovedEvent.event.data.index.toNumber()

  // payout
  const payoutEvents = await sendTransaction(
    relayClient.api.tx.treasury.payout(spendIndex).signAsync(testAccounts.alice),
  )

  // create blocks on RC and AH to ensure that payout is properly processed
  await relayClient.dev.newBlock()
  await checkEvents(payoutEvents, { section: 'treasury', method: 'Paid' })
    .redact({ redactKeys: /paymentId|index/ })
    .toMatchSnapshot('payout events')
  const [paidEvent] = (await relayClient.api.query.system.events()).filter(
    ({ event }) => event.section === 'treasury' && event.method === 'Paid',
  )
  expect(paidEvent).toBeDefined()
  assert(relayClient.api.events.treasury.Paid.is(paidEvent.event))
  const payoutIndex = paidEvent.event.data.index.toNumber()
  expect(payoutIndex).toBe(spendIndex)

  // treasury spend does not emit any event on AH so we need to check that Alice's balance is increased by the `amount` directly
  await assetHubClient.dev.newBlock()
  const balanceAfter = await assetHubClient.api.query.assets.account(USDT_ID, testAccounts.alice.address)
  const balanceAfterAmount = balanceAfter.isNone ? 0n : balanceAfter.unwrap().balance.toBigInt()
  const balanceBeforeAmount = balanceBefore.isNone ? 0n : balanceBefore.unwrap().balance.toBigInt()
  expect(balanceAfterAmount - balanceBeforeAmount).toBe(amount)
}

/**
 * Helper: Creates and schedules a treasury spend proposal
 */
async function createSpendProposal<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>, spendAmount: bigint) {
  const spendTx = relayClient.api.tx.treasury.spend(ASSET_KIND, spendAmount, BENEFICIARY_LOCATION, null)
  const hexSpendTx = spendTx.method.toHex()
  await scheduleInlineCallWithOrigin(relayClient, hexSpendTx, { Origins: SPEND_ORIGIN })
}

/**
 * Helper: Verify that the AssetSpendApproved event was emitted
 */
async function verifySystemEventAssetSpendApproved<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>) {
  await checkSystemEvents(relayClient, { section: 'treasury', method: 'AssetSpendApproved' })
    .redact({ redactKeys: /expireAt|validFrom|index/ })
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
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  const [relayClient] = await setupNetworks(relayChain)

  // Setup test accounts
  await setupTestAccounts(relayClient, ['alice', 'bob'])

  // Get initial spend count
  const initialSpendCount = await getSpendCount(relayClient)

  // Create a spend proposal
  const existentialDeposit = relayClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER
  await createSpendProposal(relayClient, spendAmount)

  await relayClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(relayClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(relayClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(relayClient, 'AssetSpendApproved')
  const spend = await relayClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const validFrom = spendData.validFrom.toNumber()
  const payoutPeriod = relayClient.api.consts.treasury.payoutPeriod.toNumber()
  expect(spendData.expireAt.toNumber()).toBe(validFrom + payoutPeriod)

  await relayClient.teardown()
}

/**
 * Helper: Void a previously approved spend proposal
 */
async function voidApprovedSpendProposal<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>, spendIndex: number) {
  const removeApprovedSpendTx = relayClient.api.tx.treasury.voidSpend(spendIndex)
  const hexRemoveApprovedSpendTx = removeApprovedSpendTx.method.toHex()
  await scheduleInlineCallWithOrigin(relayClient, hexRemoveApprovedSpendTx, { Origins: REJECT_ORIGIN })
}

/**
 * Helper: Verify that the AssetSpendVoided event was emitted
 */
async function verifySystemEventAssetSpendVoided<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>) {
  await checkSystemEvents(relayClient, { section: 'treasury', method: 'AssetSpendVoided' })
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
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  const [relayClient] = await setupNetworks(relayChain)

  // Setup test accounts
  await setupTestAccounts(relayClient, ['alice', 'bob'])

  // Get initial spend count
  const initialSpendCount = await getSpendCount(relayClient)

  // Create a spend proposal
  const existentialDeposit = relayClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  await createSpendProposal(relayClient, spendAmount)

  await relayClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(relayClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(relayClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(relayClient, 'AssetSpendApproved')
  const spend = await relayClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const validFrom = spendData.validFrom.toNumber()
  const payoutPeriod = relayClient.api.consts.treasury.payoutPeriod.toNumber()
  expect(spendData.expireAt.toNumber()).toBe(validFrom + payoutPeriod)

  await relayClient.dev.newBlock()

  // Void the approved proposal
  await voidApprovedSpendProposal(relayClient, spendIndex)

  await relayClient.dev.newBlock()

  // Check that AssetSpendVoided event was emitted
  await verifySystemEventAssetSpendVoided(relayClient)

  // Verify the spend was removed from the storage
  const spendAfter = await relayClient.api.query.treasury.spends(spendIndex)
  expect(spendAfter.isNone).toBe(true)

  await relayClient.teardown()
}

/**
 *  Helper: Create a function sendPayoutTx by the beneficiary
 */
async function sendPayoutTx<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>, spendIndex: number, beneficiary: KeyringPair) {
  const payoutTx = relayClient.api.tx.treasury.payout(spendIndex)
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
 * Helper: Get the balance amount of the account on Asset Hub for USDT
 */
async function getAssetHubUSDTBalanceAmount<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, accountAddress: string): Promise<bigint> {
  const balance = await assetHubClient.api.query.assets.account(USDT_ID, accountAddress)
  return balance.isNone ? 0n : balance.unwrap().balance.toBigInt()
}

/**
 * Helper: Set the initial balance amount of the account on Asset Hub for USDT
 *
 * This is required to ensure that the account exists on Asset Hub for the payout to happen
 */
async function setInitialUSDTBalanceOnAssetHub<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHubClient: Client<TCustom, TInitStoragesPara>, accountAddress: string): Promise<void> {
  await assetHubClient.dev.setStorage({
    Assets: {
      account: [[[USDT_ID, accountAddress], { balance: 1000e6 }]],
    },
  })
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
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, ahChain: Chain<TCustom, TInitStoragesPara>) {
  const [relayClient, assetHubClient] = await setupNetworks(relayChain, ahChain)

  // Setup test accounts
  await setupTestAccounts(relayClient, ['alice', 'bob'])

  // Ensure that Alice's account has some USDT balance on Asset Hub i.e her account should exist on Asset Hub for the payout to happen
  await setInitialUSDTBalanceOnAssetHub(assetHubClient, testAccounts.alice.address)

  // Get initial spend count
  const initialSpendCount = await getSpendCount(relayClient)

  // Create a spend proposal
  const existentialDeposit = relayClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  await createSpendProposal(relayClient, spendAmount)

  await relayClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(relayClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(relayClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(relayClient, 'AssetSpendApproved')
  const spend = await relayClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const balanceAmountBefore = await getAssetHubUSDTBalanceAmount(assetHubClient, testAccounts.alice.address)

  await relayClient.dev.newBlock()

  // Claim the spend by the beneficiary i.e alice
  const payoutEvents = await sendPayoutTx(relayClient, spendIndex, testAccounts.alice)

  await relayClient.dev.newBlock()

  await verifyEventPaid(payoutEvents)

  const payoutIndex = await getSpendIndexFromEvent(relayClient, 'Paid')
  expect(payoutIndex).toBe(spendIndex)

  // / treasury spend does not emit any event on AH so we need to check that Alice's balance is increased by the `amount` directly
  await assetHubClient.dev.newBlock()

  // Ensure that Alice's balance is increased by the `amount`
  const balanceAmountAfter = await getAssetHubUSDTBalanceAmount(assetHubClient, testAccounts.alice.address)
  expect(balanceAmountAfter - balanceAmountBefore).toBe(spendAmount)

  await relayClient.teardown()
}

async function verifyEventSpendProcessed(events: { events: Promise<Codec | Codec[]> }) {
  await checkEvents(events, { section: 'treasury', method: 'SpendProcessed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('spend processed events')
}

async function sendCheckStatusTx<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayClient: Client<TCustom, TInitStoragesRelay>, spendIndex: number) {
  const checkStatusTx = relayClient.api.tx.treasury.checkStatus(spendIndex)
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
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, ahChain: Chain<TCustom, TInitStoragesPara>) {
  const [relayClient, assetHubClient] = await setupNetworks(relayChain, ahChain)

  // Setup test accounts
  await setupTestAccounts(relayClient, ['alice', 'bob'])

  // Ensure that Alice's account has some USDT balance on Asset Hub i.e her account should exist on Asset Hub for the payout to happen
  await setInitialUSDTBalanceOnAssetHub(assetHubClient, testAccounts.alice.address)

  // Get initial spend count
  const initialSpendCount = await getSpendCount(relayClient)

  // Create a spend proposal
  const existentialDeposit = relayClient.api.consts.balances.existentialDeposit.toBigInt()
  const spendAmount = existentialDeposit * SPEND_AMOUNT_MULTIPLIER

  await createSpendProposal(relayClient, spendAmount)

  await relayClient.dev.newBlock()

  // Verify that the AssetSpendApproved event was emitted
  await verifySystemEventAssetSpendApproved(relayClient)

  // Verify spend count increased
  const newSpendCount = await getSpendCount(relayClient)
  expect(newSpendCount).toBe(initialSpendCount + 1)

  // Verify the spend was stored correctly
  const spendIndex = await getSpendIndexFromEvent(relayClient, 'AssetSpendApproved')
  const spend = await relayClient.api.query.treasury.spends(spendIndex)

  expect(spend.isSome).toBeTruthy()
  const spendData = spend.unwrap()
  expect(spendData.amount.toBigInt()).toBe(spendAmount)
  expect(spendData.status.isPending).toBe(true)

  const balanceAmountBefore = await getAssetHubUSDTBalanceAmount(assetHubClient, testAccounts.alice.address)

  await relayClient.dev.newBlock()

  // Claim the spend by the beneficiary i.e alice
  const payoutEvents = await sendPayoutTx(relayClient, spendIndex, testAccounts.alice)

  await relayClient.dev.newBlock()

  await verifyEventPaid(payoutEvents)

  const payoutIndex = await getSpendIndexFromEvent(relayClient, 'Paid')
  expect(payoutIndex).toBe(spendIndex)

  // / treasury spend does not emit any event on AH so we need to check that Alice's balance is increased by the `amount` directly
  await assetHubClient.dev.newBlock()

  // Ensure that Alice's balance is increased by the `amount`
  const balanceAmountAfter = await getAssetHubUSDTBalanceAmount(assetHubClient, testAccounts.alice.address)
  expect(balanceAmountAfter - balanceAmountBefore).toBe(spendAmount)

  await relayClient.dev.newBlock()

  const checkStatusEvents = await sendCheckStatusTx(relayClient, spendIndex)

  await relayClient.dev.newBlock()

  // verify SpendProcessed event
  await verifyEventSpendProcessed(checkStatusEvents)

  // verify the spend is removed from the storage
  const spendAfterCheckStatus = await relayClient.api.query.treasury.spends(spendIndex)
  expect(spendAfterCheckStatus.isNone).toBe(true)

  await relayClient.teardown()
}

export function baseTreasuryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  ahChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: { testSuiteName: string; addressEncoding: number },
): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'Foreign asset spend from Relay treasury is reflected on AssetHub',
        testFn: async () => await treasurySpendForeignAssetTest(relayChain, ahChain),
      },
      {
        kind: 'test',
        label: 'Propose and approve a spend of treasury funds',
        testFn: async () => await treasurySpendBasicTest(relayChain),
      },
      // Treasury spend proposal rejection
      {
        kind: 'test',
        label: 'Void previously approved spend',
        testFn: async () => await voidApprovedTreasurySpendProposal(relayChain),
      },
      // Claim a spend
      {
        kind: 'test',
        label: 'Claim a spend',
        testFn: async () => await claimTreasurySpend(relayChain, ahChain),
      },
      // Check the status of the spend and remove it from the storage if processed
      {
        kind: 'test',
        label: 'Check status of a spend and remove it from the storage if processed',
        testFn: async () => await checkStatusOfTreasurySpend(relayChain, ahChain),
      },
    ],
  }
}
