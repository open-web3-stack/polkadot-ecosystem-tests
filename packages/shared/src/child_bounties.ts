import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

import { logAllEvents } from './helpers/bounties.js'
import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// initial funding balance for accounts
const TEST_ACCOUNT_BALANCE_MULTIPLIER = 10000n // 10,000x existential deposit

// 4 blocks before the spend period block
const TREASURY_SETUP_OFFSET = 4

// multipliers for the bounty and curator fee
// 1000x existential deposit for substantial bounty value
const BOUNTY_MULTIPLIER = 1000n
// 10% curator fee (100/1000)
const CURATOR_FEE_MULTIPLIER = 100n

// 100x existential deposit for substantial child bounty value
const CHILD_BOUNTY_MULTIPLIER = 100n
// 10% curator fee (10/100)
const CHILD_CURATOR_FEE_MULTIPLIER = 10n

/**
 * Get a bounty by index
 */
async function getBounty(client: Client<any, any>, bountyIndex: number): Promise<any | null> {
  const bounty = await client.api.query.bounties.bounties(bountyIndex)
  if (!bounty) return null
  return bounty.isSome ? bounty.unwrap() : null
}

/**
 * Get approved bounties queue
 */
async function getBountyApprovals(client: Client<any, any>): Promise<number[]> {
  const approvals = await client.api.query.bounties.bountyApprovals()
  return approvals.map((index: any) => index.toNumber())
}

/**
 * Setup accounts with funds for testing
 */
async function setupTestAccounts(client: Client<any, any>, accounts: string[] = ['alice', 'bob', 'charlie', 'dave']) {
  const accountMap = {
    alice: testAccounts.alice.address,
    bob: testAccounts.bob.address,
    charlie: testAccounts.charlie.address,
    dave: testAccounts.dave.address,
  }

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const testAccountBalance = TEST_ACCOUNT_BALANCE_MULTIPLIER * existentialDeposit

  const accountData = accounts
    .filter((account) => accountMap[account as keyof typeof accountMap])
    .map((account) => [
      [accountMap[account as keyof typeof accountMap]],
      { providers: 1, data: { free: testAccountBalance } },
    ])

  await client.dev.setStorage({
    System: {
      account: accountData,
    },
  })
}

/**
 * Get bounty index from BountyProposed event
 */
async function getBountyIndexFromEvent(client: Client<any, any>): Promise<number> {
  const [bountyProposedEvent] = (await client.api.query.system.events()).filter(
    ({ event }: any) => event.section === 'bounties' && event.method === 'BountyProposed',
  )
  expect(bountyProposedEvent).toBeTruthy()
  assert(client.api.events.bounties.BountyProposed.is(bountyProposedEvent.event))
  return bountyProposedEvent.event.data.index.toNumber()
}

/**
 * Get child bounty index from ChildBountyAdded event
 */
async function getChildBountyIndexFromEvent(
  client: Client<any, any>,
): Promise<{ parentIndex: number; childIndex: number }> {
  const [childBountyAddedEvent] = (await client.api.query.system.events()).filter(
    ({ event }: any) => event.section === 'childBounties' && event.method === 'Added',
  )
  expect(childBountyAddedEvent).toBeTruthy()
  assert(client.api.events.childBounties.Added.is(childBountyAddedEvent.event))
  return {
    parentIndex: childBountyAddedEvent.event.data.index.toNumber(),
    childIndex: childBountyAddedEvent.event.data.childIndex.toNumber(),
  }
}

/**
 * Get bounty account address from NewAccount event
 */
async function getBountyAccountFromEvent(client: Client<any, any>): Promise<string> {
  const [newAccountEvent] = (await client.api.query.system.events()).filter(
    ({ event }: any) => event.section === 'system' && event.method === 'NewAccount',
  )
  expect(newAccountEvent).toBeTruthy()
  assert(client.api.events.system.NewAccount.is(newAccountEvent.event))
  return newAccountEvent.event.data.account.toString()
}

/**
 * Get a child bounty by parent and child index
 */
async function getChildBounty(client: Client<any, any>, parentIndex: number, childIndex: number): Promise<any | null> {
  const childBounty = await client.api.query.childBounties.childBounties(parentIndex, childIndex)
  if (!childBounty) return null
  return childBounty.isSome ? childBounty.unwrap() : null
}

/**
 * Get child bounty description by parent and child index
 */
async function getChildBountyDescription(
  client: Client<any, any>,
  parentIndex: number,
  childIndex: number,
): Promise<string | null> {
  const description = await client.api.query.childBounties.childBountyDescriptionsV1(parentIndex, childIndex)
  return description.isSome ? description.unwrap().toUtf8() : null
}

/**
 * Get parent child bounties count
 */
async function getParentChildBountiesCount(client: Client<any, any>, parentIndex: number): Promise<number> {
  return (await client.api.query.childBounties.parentChildBounties(parentIndex)).toNumber()
}

/**
 * Get parent total child bounties count per parent bounty index including completed bounties
 */
async function getParentTotalChildBountiesCount(client: Client<any, any>, parentIndex: number): Promise<number> {
  return (await client.api.query.childBounties.parentTotalChildBounties(parentIndex)).toNumber()
}

/**
 * Sets the treasury's last spend period block number to enable bounty funding
 * @param client - The chain client
 */
async function setLastSpendPeriodBlockNumber(client: Client<any, any>) {
  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + TREASURY_SETUP_OFFSET
  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })
}

async function extractExtrinsicFailedEvent(client: Client<any, any>): Promise<any> {
  const events = await client.api.query.system.events()
  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  if (!ev) {
    throw new Error('No ExtrinsicFailed event found')
  }
  return ev
}

/// -------
/// Tests
/// -------

/**
 * Test: child bounty creation test.
 *
 * This test verifies the fundamental child bounty creation workflow to ensure that:
 * - Child bounties can only be created from active parent bounties
 * - The parent bounty curator has the authority to create child bounties
 * - Proper events are emitted and storage is updated during creation
 *
 * Test structure:
 * 1. Alice creates a parent bounty and it goes through the full lifecycle (propose → approve → fund → assign curator → accept curator)
 * 2. Bob (as parent curator) creates a child bounty from the active parent bounty
 * 3. Verify proper events are emitted and child bounty is stored correctly
 */
export async function childBountyCreationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for child bounty creation'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the bounty status is Proposed
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  // approve the bounty with origin Treasurer
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event is emitted
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  // verify the bounty is added to the approvals queue
  const approvalsFromStorage = await getBountyApprovals(client)
  expect(approvalsFromStorage).toContain(bountyIndex)

  await client.dev.newBlock()
  // This is the spendPeriodBlock i.e bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // verify the status of the bounty after funding is funded
  const bountyStatusAfterApproval = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterApproval.status.isFunded).toBe(true)

  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // verify the bounty status is CuratorProposed
  const bountyStatusAfterCuratorProposed = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorProposed.status.isCuratorProposed).toBe(true)

  await client.dev.newBlock()

  // accept the curator
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the bounty status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  const parentChildBountiesCountBefore = await getParentChildBountiesCount(client, bountyIndex)
  const parentTotalChildBountiesCountBefore = await getParentTotalChildBountiesCount(client, bountyIndex)

  // Note: The curator (Bob) should create the child bounty, not Alice
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER // Smaller value for child bounty
  const childBountyDescription = 'Test child bounty'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Check for ChildBountyAdded event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Added' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('child bounty added events')

  // get child bounty index
  const { childIndex } = await getChildBountyIndexFromEvent(client)

  // verify the count of ParentChildBounties and ParentTotalChildBounties increased by 1
  const parentChildBountiesCountAfter = await getParentChildBountiesCount(client, bountyIndex)
  const parentTotalChildBountiesCountAfter = await getParentTotalChildBountiesCount(client, bountyIndex)
  expect(parentChildBountiesCountAfter).toBe(parentChildBountiesCountBefore + 1)
  expect(parentTotalChildBountiesCountAfter).toBe(parentTotalChildBountiesCountBefore + 1)

  // verify the description of the child bounty is set
  const retrievedChildBountyDescription = await getChildBountyDescription(client, bountyIndex, childIndex)
  expect(retrievedChildBountyDescription).toBe(childBountyDescription)

  // verify the child bounty is added to the ChildBounties storage
  const childBounty = await getChildBounty(client, bountyIndex, childIndex)
  expect(childBounty).toBeTruthy()
  expect(childBounty.status.isAdded).toBe(true)

  await client.teardown()
}

/**
 * Test: assigning and accepting a child bounty curator.
 *
 * This test verifies the child bounty curator assignment workflow to ensure that:
 * - Child bounties can have their own dedicated curators separate from parent bounty curators
 * - Curator assignment follows the same propose/accept pattern as parent bounties
 * - Proper state transitions occur when curators are assigned and accepted
 *
 * Test structure:
 * 1. Create parent bounty and make it active with Bob as curator
 * 2. Bob creates a child bounty from the parent bounty
 * 3. Bob proposes Charlie as curator for the child bounty
 * 4. Charlie accepts the curator role, transitioning child bounty to Active status
 */
export async function childBountyAssigningAndAcceptingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for assigning and accepting a child bounty curator'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the bounty status is Proposed
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  // approve the bounty with origin Treasurer
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event is emitted
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  // verify the bounty is added to the approvals queue
  const approvalsFromStorage = await getBountyApprovals(client)
  expect(approvalsFromStorage).toContain(bountyIndex)

  await client.dev.newBlock()
  // This is the spendPeriodBlock i.e bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // verify the status of the bounty after funding is funded
  const bountyStatusAfterApproval = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterApproval.status.isFunded).toBe(true)

  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // verify the bounty status is CuratorProposed
  const bountyStatusAfterCuratorProposed = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorProposed.status.isCuratorProposed).toBe(true)

  await client.dev.newBlock()

  // accept the curator
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the bounty status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for curator assignment'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Check for ChildBountyAdded event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Added' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('child bounty added events')

  // Get child bounty indices
  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)
  expect(parentIndex).toBe(bountyIndex)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // Propose curator for child bounty
  const childCuratorFee = existentialDeposit.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Verify child bounty status is CuratorProposed
  const childBountyAfterCuratorProposed = await getChildBounty(client, parentIndex, childIndex)
  expect(childBountyAfterCuratorProposed.status.isCuratorProposed).toBe(true)

  // Accept child bounty curator
  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty status is Active
  const childBountyAfterCuratorAccepted = await getChildBounty(client, parentIndex, childIndex)
  expect(childBountyAfterCuratorAccepted.status.isActive).toBe(true)

  await client.teardown()
}

/**
 * Test: awarding and claiming a child bounty.
 *
 * This test verifies the complete child bounty lifecycle from award to claim to ensure that:
 * - Child bounty curators can award bounties to beneficiaries
 * - The payout delay mechanism works correctly for child bounties
 * - Beneficiaries can successfully claim awarded child bounties after the delay
 * - Proper cleanup occurs after successful claim
 *
 * Test structure:
 * 1. Create parent bounty and make it active with Bob as curator
 * 2. Bob creates child bounty and assigns Charlie as child curator
 * 3. Charlie awards the child bounty to Dave (beneficiary)
 * 4. Wait for payout delay period and Dave claims the bounty
 * 5. Verify proper events and storage cleanup
 */
export async function childBountyAwardingAndClaimingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'awarding and claiming a child bounty'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty is funded in this block
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for awarding'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Assign and accept curator for child bounty
  const childCuratorFee = existentialDeposit.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty is active
  const activeChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(activeChildBounty.status.isActive).toBe(true)

  // Award child bounty to beneficiary (Dave)
  const awardChildBountyTx = client.api.tx.childBounties.awardChildBounty(
    parentIndex,
    childIndex,
    testAccounts.dave.address,
  )
  await sendTransaction(awardChildBountyTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Check for ChildBountyAwarded event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Awarded' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('child bounty awarded events')

  // Verify child bounty status is PendingPayout
  const awardedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(awardedChildBounty.status.isPendingPayout).toBe(true)

  // Get payout delay from constants
  const payoutDelay = await client.api.consts.bounties.bountyDepositPayoutDelay

  // Fast forward to after payout delay
  await client.dev.newBlock({ count: payoutDelay.toNumber() + 1 })

  // Claim the child bounty
  const claimChildBountyTx = client.api.tx.childBounties.claimChildBounty(parentIndex, childIndex)
  await sendTransaction(claimChildBountyTx.signAsync(testAccounts.dave))

  await client.dev.newBlock()

  // Check for ChildBountyClaimed event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Claimed' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('child bounty claimed events')

  // Verify child bounty is removed from storage
  const claimedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(claimedChildBounty).toBeNull()

  await client.teardown()
}

/**
 * Test: closure and payout of a child bounty
 *
 * This test verifies the child bounty closure mechanism to ensure that:
 * - Parent bounty curators can close child bounties before they are awarded
 * - Funds are properly returned to the parent bounty account when child bounties are closed
 * - Storage is correctly cleaned up when child bounties are closed
 * - Child bounty counters are properly decremented
 *
 * Test structure:
 * 1. Create parent bounty and make it active with Bob as curator
 * 2. Bob creates child bounty and assigns Charlie as child curator
 * 3. Bob closes the child bounty before it's awarded
 * 4. Verify funds are returned to parent bounty account and storage is cleaned up
 */
export async function childBountyClosureAndPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for child bounty closure'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()

  // Get the bounty account address from the NewAccount event that was emitted when the bounty was funded
  const parentBountyAccount = await getBountyAccountFromEvent(client)

  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for closure'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Assign and accept curator for child bounty
  const childCuratorFee = existentialDeposit.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty is active
  const activeChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(activeChildBounty.status.isActive).toBe(true)

  // get the parent bounty account balance before closing the child bounty
  const parentBalanceBeforeClosing = await client.api.query.system.account(parentBountyAccount)
  const parentBalanceBeforeClosingValue = parentBalanceBeforeClosing.data.free.toBigInt()

  // Close child bounty (by parent curator)
  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex)
  await sendTransaction(closeChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Check for ChildBountyCanceled event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Canceled' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('child bounty canceled events')

  // Verify child bounty is removed from storage
  const closedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(closedChildBounty).toBeNull()

  // Verify child bounty description is removed
  const childBountyDesc = await getChildBountyDescription(client, parentIndex, childIndex)
  expect(childBountyDesc).toBeNull()

  // Verify parent bounty account balance increased (funds returned to parent bounty)
  const parentBalanceAfter = await client.api.query.system.account(parentBountyAccount)
  const parentBalanceAfterValue = parentBalanceAfter.data.free.toBigInt()
  expect(parentBalanceAfterValue).toBe(parentBalanceBeforeClosingValue + childBountyValue)

  // Verify child bounties count decreased
  const childBountiesCount = await getParentChildBountiesCount(client, parentIndex)
  expect(childBountiesCount).toBe(0)

  await client.teardown()
}

/**
 * Test: rejection by child curator and closure by parent curator of a child bounty
 *
 * This test verifies the child bounty rejection and closure workflows to ensure that:
 * - Proposed child bounty curators can reject their assignment (unassign themselves)
 * - Parent bounty curators can cancel child bounties at any time
 * - Proper state transitions occur during rejection and cancellation
 * - Storage cleanup happens correctly in both scenarios
 *
 * Test structure:
 * 1. Create parent bounty and make it active with Bob as curator
 * 2. Bob creates child bounty and proposes Charlie as curator
 * 3. Charlie rejects the assignment (unassigns himself)
 * 4. Bob proposes Charlie again, then cancels the child bounty
 * 5. Verify proper events and storage cleanup in both cases
 */
export async function childBountyRejectionAndCancellationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for child bounty rejection'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for rejection'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Propose curator for child bounty
  const childCuratorFee = existentialDeposit.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Verify child bounty status is CuratorProposed
  const proposedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(proposedChildBounty.status.isCuratorProposed).toBe(true)

  // Test 1: Curator rejects the assignment (unassigns themselves)
  const unassignCuratorTx = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty status is back to Added
  const rejectedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(rejectedChildBounty.status.isAdded).toBe(true)

  // Test 2: Propose curator again and then cancel the child bounty
  const proposeChildCuratorTx2 = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx2.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Verify child bounty status is CuratorProposed again
  const proposedChildBounty2 = await getChildBounty(client, parentIndex, childIndex)
  expect(proposedChildBounty2.status.isCuratorProposed).toBe(true)

  // Cancel child bounty by parent curator
  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex)
  await sendTransaction(closeChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Check for ChildBountyCanceled event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Canceled' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('child bounty canceled events')

  // Verify child bounty is removed from storage
  const canceledChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(canceledChildBounty).toBeNull()

  // Verify child bounty description is removed
  const childBountyDesc = await getChildBountyDescription(client, parentIndex, childIndex)
  expect(childBountyDesc).toBeNull()

  // Verify child bounties count is 0
  const childBountiesCount = await getParentChildBountiesCount(client, parentIndex)
  expect(childBountiesCount).toBe(0)

  await client.teardown()
}

/**
 * Test: unassign curator different cases
 *
 * This test verifies the different curator unassignment scenarios to ensure that:
 * - Self-unassignment by child curators refunds their deposit
 * - Unassignment by parent curators slashes the child curator's deposit
 * - Unauthorized unassignment attempts fail with appropriate errors
 * - Different deposit handling based on who initiates the unassignment
 *
 * Test structure:
 * 1. Create parent bounty and child bounty with active curator (Charlie)
 * 2. Test child curator self-unassignment (should refund deposit)
 * 3. Re-assign and test parent curator unassignment (should slash deposit)
 * 4. Re-assign and test unauthorized unassignment (should fail with Premature error)
 */
export async function childBountyUnassignCuratorEdgeCasesTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave', 'eve'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for unassign curator edge cases'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for unassign edge cases'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Assign and accept curator for child bounty
  const childCuratorFee = existentialDeposit.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty is active
  const activeChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(activeChildBounty.status.isActive).toBe(true)

  // get charlie's free balance before unassign
  const charlieAccountBeforeSelfUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  const freeBalanceBeforeSelfUnassign = charlieAccountBeforeSelfUnassign.data.free.toBigInt()

  // Test 1: Child curator self-unassigns (should refund deposit)
  const unassignCuratorTx1 = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx1.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // get charlie's free balance after self unassign
  const charlieAccountAfterSelfUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  const freeBalanceAfterSelfUnassign = charlieAccountAfterSelfUnassign.data.free.toBigInt()
  // reserve balance is refunded to curator after self unassign
  expect(freeBalanceAfterSelfUnassign).toBeGreaterThan(freeBalanceBeforeSelfUnassign)

  // Verify child bounty status is back to Added
  const unassignedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(unassignedChildBounty.status.isAdded).toBe(true)

  // Re-assign curator for next test
  const proposeChildCuratorTx2 = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx2.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const acceptChildCuratorTx2 = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx2.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // get charlie's free balance before unassign
  const charlieAccountBeforeUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  const freeBalanceBeforeUnassign = charlieAccountBeforeUnassign.data.free.toBigInt()

  // Test 2: Parent curator unassigns child curator (should slash deposit)
  const unassignCuratorTx2 = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx2.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify charlie's reserve balance is slashed event
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('balances slash events')

  // get charlie's free balance after unassign
  const charlieAccountAfterUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  const freeBalanceAfterUnassign = charlieAccountAfterUnassign.data.free.toBigInt()
  // should be the same as reserved balance is slashed
  expect(freeBalanceAfterUnassign).toBe(freeBalanceBeforeUnassign)

  // Verify child bounty status is back to Added
  const slashedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(slashedChildBounty.status.isAdded).toBe(true)

  // Re-assign curator for next test
  const proposeChildCuratorTx3 = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx3.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const acceptChildCuratorTx3 = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx3.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Test 3: Community member tries to unassign active curator (should fail with Premature)
  const unassignCuratorTx3 = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx3.signAsync(testAccounts.dave))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.Premature.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: storage verification
 *
 * This test verifies the child bounty storage management to ensure that:
 * - All child bounty storage items are correctly updated during operations
 * - Counters (active and total) are properly maintained
 * - Storage cleanup occurs correctly after child bounty completion
 * - Multiple child bounties are handled correctly
 *
 * Test structure:
 * 1. Create parent bounty and make it active
 * 2. Create multiple child bounties and verify storage updates
 * 3. Complete one child bounty (award and claim) and verify storage cleanup
 * 4. Verify counters and remaining storage items are correct
 */
export async function childBountyStorageVerificationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for storage verification'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create first child bounty
  const childBountyValue1 = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription1 = 'First child bounty for storage test'

  const addChildBountyTx1 = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue1,
    childBountyDescription1,
  )
  await sendTransaction(addChildBountyTx1.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex: parentIndex1, childIndex: childIndex1 } = await getChildBountyIndexFromEvent(client)

  // Verify storage items
  let activeCount = await getParentChildBountiesCount(client, parentIndex1)
  expect(activeCount).toBe(1)

  const totalCount = await client.api.query.childBounties.parentTotalChildBounties(parentIndex1)
  expect(totalCount.toNumber()).toBe(1)

  const childBountyDesc1 = await getChildBountyDescription(client, parentIndex1, childIndex1)
  expect(childBountyDesc1).toBe(childBountyDescription1)

  // Create second child bounty
  const childBountyValue2 = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription2 = 'Second child bounty for storage test'

  const addChildBountyTx2 = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue2,
    childBountyDescription2,
  )
  await sendTransaction(addChildBountyTx2.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex: parentIndex2, childIndex: childIndex2 } = await getChildBountyIndexFromEvent(client)

  // Verify storage items updated
  activeCount = await getParentChildBountiesCount(client, parentIndex2)
  expect(activeCount).toBe(2)

  const totalCount2 = await client.api.query.childBounties.parentTotalChildBounties(parentIndex2)
  expect(totalCount2.toNumber()).toBe(2)

  const childBountyDesc2 = await getChildBountyDescription(client, parentIndex2, childIndex2)
  expect(childBountyDesc2).toBe(childBountyDescription2)

  // Assign and accept curator for first child bounty
  const childCuratorFee1 = existentialDeposit.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx1 = client.api.tx.childBounties.proposeCurator(
    parentIndex1,
    childIndex1,
    testAccounts.charlie.address,
    childCuratorFee1,
  )
  await sendTransaction(proposeChildCuratorTx1.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const acceptChildCuratorTx1 = client.api.tx.childBounties.acceptCurator(parentIndex1, childIndex1)
  await sendTransaction(acceptChildCuratorTx1.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify ChildrenCuratorFees storage
  const childrenCuratorFees = await client.api.query.childBounties.childrenCuratorFees(parentIndex1)
  expect(childrenCuratorFees.toBigInt()).toBe(childCuratorFee1)

  // Award and claim first child bounty
  const awardChildBountyTx1 = client.api.tx.childBounties.awardChildBounty(
    parentIndex1,
    childIndex1,
    testAccounts.dave.address,
  )
  await sendTransaction(awardChildBountyTx1.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Get payout delay and fast forward
  const payoutDelay = await client.api.consts.bounties.bountyDepositPayoutDelay
  await client.dev.newBlock({ count: payoutDelay.toNumber() + 1 })

  const claimChildBountyTx1 = client.api.tx.childBounties.claimChildBounty(parentIndex1, childIndex1)
  await sendTransaction(claimChildBountyTx1.signAsync(testAccounts.dave))

  await client.dev.newBlock()

  // Verify storage cleanup after claim
  const claimedChildBounty = await getChildBounty(client, parentIndex1, childIndex1)
  expect(claimedChildBounty).toBeNull()

  const claimedChildBountyDesc = await getChildBountyDescription(client, parentIndex1, childIndex1)
  expect(claimedChildBountyDesc).toBeNull()

  // Active count should decrease, total count should remain
  activeCount = await getParentChildBountiesCount(client, parentIndex1)
  expect(activeCount).toBe(1)

  const totalCountAfterClaim = await client.api.query.childBounties.parentTotalChildBounties(parentIndex1)
  expect(totalCountAfterClaim.toNumber()).toBe(2)

  // ChildrenCuratorFees should remain the same after child bounty claim
  const childrenCuratorFeesAfterClaim = await client.api.query.childBounties.childrenCuratorFees(parentIndex1)
  expect(childrenCuratorFeesAfterClaim.toBigInt()).toBe(childCuratorFee1)

  await client.teardown()
}

/**
 * All child bounty success tests
 *
 */
export function allChildBountiesSuccessTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All child bounties success tests',
    children: [
      {
        kind: 'test',
        label: 'child bounty creation',
        testFn: async () => await childBountyCreationTest(chain),
      },
      {
        kind: 'test',
        label: 'assigning and accepting a child bounty curator',
        testFn: async () => await childBountyAssigningAndAcceptingTest(chain),
      },
      {
        kind: 'test',
        label: 'awarding and claiming a child bounty',
        testFn: async () => await childBountyAwardingAndClaimingTest(chain),
      },
      {
        kind: 'test',
        label: 'closure and payout of a child bounty',
        testFn: async () => await childBountyClosureAndPayoutTest(chain),
      },
      {
        kind: 'test',
        label: 'rejection by child curator and closure by parent curator of a child bounty',
        testFn: async () => await childBountyRejectionAndCancellationTest(chain),
      },
      {
        kind: 'test',
        label: 'unassign curator different cases',
        testFn: async () => await childBountyUnassignCuratorEdgeCasesTest(chain),
      },
      {
        kind: 'test',
        label: 'child bounty storage verification',
        testFn: async () => await childBountyStorageVerificationTest(chain),
      },
    ],
  } as RootTestTree
}

/**
 * Test: create child bounty from non-active parent bounty throws `ParentBountyNotActive` error
 *
 * This test verifies the `ParentBountyNotActive` error condition to ensure that:
 * - Child bounties can only be created from active parent bounties
 * - Attempting to create child bounties from non-active parent bounties fails appropriately
 * - The error handling provides clear feedback about the invalid state
 *
 * Test structure:
 * 1. Create parent bounty but don't activate it (leave it in Proposed state)
 * 2. Attempt to create child bounty from the non-active parent bounty
 * 3. Verify the transaction fails with `ParentBountyNotActive` error
 */
export async function childBountyParentBountyNotActiveErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for error testing'

  // Create parent bounty but don't activate it
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Try to create child bounty while parent is still Proposed (not active)
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty that should fail'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )

  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Check the result of dispatched event
  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.childBounties.ParentBountyNotActive.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: create child bounty with value larger than parent bounty balance throws `InsufficientBountyBalance` error
 *
 * This test verifies the `InsufficientBountyBalance` error condition to ensure that:
 * - Child bounty values cannot exceed the available parent bounty balance
 * - The system prevents creating child bounties that would overdraw parent bounty funds
 * - Proper error handling occurs when attempting to create oversized child bounties
 *
 * Test structure:
 * 1. Create active parent bounty with a specific value
 * 2. Attempt to create child bounty with value larger than parent bounty balance
 * 3. Verify the transaction fails with `InsufficientBountyBalance` error
 */
export async function childBountyInsufficientBountyBalanceErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  // Create parent bounty with minimal value
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty with minimal value'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Try to create child bounty with value larger than parent bounty balance
  const childBountyValue = bountyValue + 1n // Larger than parent bounty
  const childBountyDescription = 'Test child bounty that should fail'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )

  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.childBounties.InsufficientBountyBalance.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: create child bounty with value below minimum throws `InvalidValue` error
 *
 * This test verifies the `InvalidValue` error condition to ensure that:
 * - Child bounty values must meet the minimum value requirement
 * - The system enforces minimum value constraints for child bounties
 * - Attempts to create child bounties below the minimum fail appropriately
 *
 * Test structure:
 * 1. Create active parent bounty
 * 2. Attempt to create child bounty with value below the minimum threshold
 * 3. Verify the transaction fails with `InvalidValue` error
 */
export async function childBountyInvalidValueErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for invalid value testing'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Get minimum child bounty value
  const childBountyValueMinimum = await client.api.consts.childBounties.childBountyValueMinimum

  // Try to create child bounty with value below minimum
  const childBountyValue = childBountyValueMinimum.toBigInt() - 1n
  const childBountyDescription = 'Test child bounty with invalid value'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )

  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidValue.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: propose curator with fee >= child bounty value throws `InvalidFee` error
 *
 * This test verifies the `InvalidFee` error condition to ensure that:
 * - Child bounty curator fees cannot equal or exceed the child bounty value
 * - The system prevents setting curator fees that would consume the entire bounty
 * - Proper validation occurs when proposing child bounty curators
 *
 * Test structure:
 * 1. Create active parent bounty and child bounty
 * 2. Attempt to propose curator with fee >= child bounty value
 * 3. Verify the transaction fails with `InvalidFee` error
 */
export async function childBountyInvalidFeeErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for invalid fee testing'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for invalid fee'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Try to propose curator with fee >= child bounty value
  const invalidCuratorFee = childBountyValue // Fee equals child bounty value
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    invalidCuratorFee,
  )

  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidFee.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: accept curator when child bounty is in `Added` status throws `UnexpectedStatus` error
 *
 * This test verifies the UnexpectedStatus error condition to ensure that:
 * - Curator acceptance can only occur when child bounty is in `CuratorProposed` status
 * - The system enforces proper state transitions for child bounty operations
 * - Attempts to accept curators in wrong states fail with appropriate errors
 *
 * Test structure:
 * 1. Create active parent bounty and child bounty
 * 2. Attempt to accept curator when child bounty is in Added status (not `CuratorProposed`)
 * 3. Verify the transaction fails with `UnexpectedStatus` error
 */
export async function childBountyUnexpectedStatusErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for unexpected status testing'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for unexpected status'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Try to accept curator when child bounty is in Added status (not CuratorProposed)
  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)

  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.UnexpectedStatus.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: close child bounty in `PendingPayout` status throws `PendingPayout` error
 *
 * This test verifies the `PendingPayout` error condition to ensure that:
 * - Child bounties in `PendingPayout` status cannot be closed
 * - The system prevents premature closure of awarded child bounties
 * - Proper state management prevents invalid operations during payout period
 *
 * Test structure:
 * 1. Create active parent bounty and child bounty
 * 2. Award child bounty to beneficiary (transitions to `PendingPayout`)
 * 3. Attempt to close child bounty while in `PendingPayout` status
 * 4. Verify the transaction fails with `PendingPayout` error
 */
export async function childBountyPendingPayoutErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for pending payout testing'

  // Create and activate parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(client, approveBountyTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()
  await client.dev.newBlock()
  await client.dev.newBlock()

  // Assign and accept curator for parent bounty
  const curatorFee = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(client, proposeCuratorTx.method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Create child bounty
  const childBountyValue = existentialDeposit.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for pending payout testing'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Assign and accept curator for child bounty
  const childCuratorFee = existentialDeposit.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Award child bounty
  const awardChildBountyTx = client.api.tx.childBounties.awardChildBounty(
    parentIndex,
    childIndex,
    testAccounts.dave.address,
  )
  await sendTransaction(awardChildBountyTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Try to close child bounty in PendingPayout status
  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex)

  await sendTransaction(closeChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.PendingPayout.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 *  All failure tests for child bounties
 *
 */
export function allChildBountiesFailureTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All child bounties failure tests',
    children: [
      {
        kind: 'test',
        label: 'create child bounty from non-active parent bounty throws `ParentBountyNotActive` error',
        testFn: async () => await childBountyParentBountyNotActiveErrorTest(chain),
      },
      {
        kind: 'test',
        label:
          'create child bounty with value larger than parent bounty balance throws `InsufficientBountyBalance` error',
        testFn: async () => await childBountyInsufficientBountyBalanceErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'create child bounty with value below minimum throws `InvalidValue` error',
        testFn: async () => await childBountyInvalidValueErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'propose curator with fee >= child bounty value throws `InvalidFee` error',
        testFn: async () => await childBountyInvalidFeeErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'accept curator when child bounty is in `Added` status throws `UnexpectedStatus` error',
        testFn: async () => await childBountyUnexpectedStatusErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'close child bounty in `PendingPayout` status throws `PendingPayout` error',
        testFn: async () => await childBountyPendingPayoutErrorTest(chain),
      },
    ],
  } as RootTestTree
}

/**
 * Base set of childBounties end-to-end tests.
 *
 */
export function baseChildBountiesE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [allChildBountiesSuccessTests(chain), allChildBountiesFailureTests(chain)],
  }
}
