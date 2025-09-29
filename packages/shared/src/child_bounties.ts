import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

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
 * Get the current bounty count
 */
async function getBountyCount(client: Client<any, any>): Promise<number> {
  return (await client.api.query.bounties.bountyCount()).toNumber()
}

/**
 * Get a bounty by index
 */
async function getBounty(client: Client<any, any>, bountyIndex: number): Promise<any | null> {
  const bounty = await client.api.query.bounties.bounties(bountyIndex)
  if (!bounty) return null
  return bounty.isSome ? bounty.unwrap() : null
}

/**
 * Get bounty description by index
 */
async function getBountyDescription(client: Client<any, any>, bountyIndex: number): Promise<string | null> {
  const description = await client.api.query.bounties.bountyDescriptions(bountyIndex)
  return description.isSome ? description.unwrap().toUtf8() : null
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

  const accountData = accounts
    .filter((account) => accountMap[account as keyof typeof accountMap])
    .map((account) => [
      [accountMap[account as keyof typeof accountMap]],
      { providers: 1, data: { free: 100000000000000n } },
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
 * Get bounty events
 */
async function getBountyEvents(client: Client<any, any>): Promise<any[]> {
  return (await client.api.query.system.events()).filter((evt: any) => evt.event?.section === 'bounties')
}

/**
 * Get childBounties events
 */
async function getChildBountyEvents(client: Client<any, any>): Promise<any[]> {
  return (await client.api.query.system.events()).filter((evt: any) => evt.event?.section === 'childBounties')
}

/**
 *  Log the bounty events
 */
async function logBountyEvents(client: any) {
  const events = await getBountyEvents(client)
  events.forEach((evt: any, idx: number) => {
    console.log(`Event #${idx}:`, evt.event?.toHuman?.() ?? evt.event)
  })
}

/**
 * Log all events
 */
async function logAllEvents(client: any) {
  const events = await client.api.query.system.events()
  events.forEach((evt: any, idx: number) => {
    console.log(`Event #${idx}:`, evt.event?.toHuman?.() ?? evt.event)
  })
}

/// -------
/// Tests
/// -------

/**
 * Test: child bounty creation test.
 *
 * 1. Alice creates a pa≠rent bounty
 * 2. Verify that Alice makes a deposit for the parent bounty creation
 * 3. Bob creates a child bounty from the parent bounty
 */
export async function childBountyCreationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4
  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

  // ensure the last spend period block number is updated in storage
  const fetchedLastSpendPeriodBlockNumber = await client.api.query.treasury.lastSpendPeriod()
  expect(fetchedLastSpendPeriodBlockNumber.unwrap().toNumber()).toBe(newLastSpendPeriodBlockNumber)

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
  const approvalsforStorage = await getBountyApprovals(client)
  expect(approvalsforStorage).toContain(bountyIndex)

  await client.dev.newBlock()
  // This is the spendPeriodBlock i.e bounty will be funded in this block
  await client.dev.newBlock()

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

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

  await client.teardown()
}

/**
 * Test: assigning and accepting a child bounty curator.
 *
 * 1. Create parent bounty and make it active
 * 2. Create child bounty
 * 3. Propose curator for child bounty
 * 4. Accept curator role
 */
export async function childBountyAssigningAndAcceptingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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
  const approvalsforStorage = await getBountyApprovals(client)
  expect(approvalsforStorage).toContain(bountyIndex)

  await client.dev.newBlock()
  // This is the spendPeriodBlock i.e bounty will be funded in this block
  await client.dev.newBlock()

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

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
 * 1. Create parent bounty and make it active
 * 2. Create child bounty with active curator
 * 3. Award child bounty to beneficiary
 * 4. Wait for payout delay and claim the bounty
 */
export async function childBountyAwardingAndClaimingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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
 * 1. Create parent bounty and make it active
 * 2. Create child bounty with active curator
 * 3. Close child bounty before awarding
 * 4. Verify funds are returned to parent bounty
 */
export async function childBountyClosureAndPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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
  const parentBalanceBeforeClosingValue = (parentBalanceBeforeClosing as any).data.free.toBigInt()

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
  const parentBalanceAfterValue = (parentBalanceAfter as any).data.free.toBigInt()
  expect(parentBalanceAfterValue).toBe(parentBalanceBeforeClosingValue + childBountyValue)

  // Verify child bounties count decreased
  const childBountiesCount = await getParentChildBountiesCount(client, parentIndex)
  expect(childBountiesCount).toBe(0)

  await client.teardown()
}

/**
 * Test: child bounty rejection and cancellation.
 *
 * 1. Create parent bounty and make it active
 * 2. Create child bounty with proposed curator
 * 3. Test curator rejection (unassign curator)
 * 4. Test child bounty cancellation by parent curator
 */
export async function childBountyRejectionAndCancellationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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
 * Test: parent bounty not active error
 *
 * 1. Create parent bounty but don't make it active
 * 2. Try to create child bounty - should fail with ParentBountyNotActive
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
  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.childBounties.ParentBountyNotActive.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: child bounty errors - InsufficientBountyBalance
 *
 * 1. Create parent bounty with minimal value
 * 2. Try to create child bounty with value larger than parent - should fail
 */
export async function childBountyInsufficientBountyBalanceErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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

  const events = await client.api.query.system.events()
  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.childBounties.InsufficientBountyBalance.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: child bounty errors - InvalidValue
 *
 * 1. Create active parent bounty
 * 2. Try to create child bounty with value below minimum - should fail
 */
export async function childBountyInvalidValueErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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

  const events = await client.api.query.system.events()
  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidValue.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: child bounty errors - InvalidFee
 *
 * 1. Create active parent bounty and child bounty
 * 2. Try to propose curator with fee >= child bounty value - should fail
 */
export async function childBountyInvalidFeeErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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

  const events = await client.api.query.system.events()
  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidFee.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: child bounty errors - UnexpectedStatus
 *
 * 1. Create active parent bounty and child bounty
 * 2. Try to accept curator when child bounty is in wrong status - should fail
 */
export async function childBountyUnexpectedStatusErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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

  const events = await client.api.query.system.events()
  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.UnexpectedStatus.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: child bounty errors - PendingPayout
 *
 * 1. Create active parent bounty and child bounty
 * 2. Award child bounty
 * 3. Try to close child bounty in PendingPayout status - should fail
 */
export async function childBountyPendingPayoutErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  const spendPeriod = await client.api.consts.treasury.spendPeriod
  const currentBlock = await client.api.rpc.chain.getHeader()
  const newLastSpendPeriodBlockNumber = currentBlock.number.toNumber() - spendPeriod.toNumber() + 4

  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

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

  const events = await client.api.query.system.events()
  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.PendingPayout.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
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
        label: 'rejection and cancellation of a child bounty',
        testFn: async () => await childBountyRejectionAndCancellationTest(chain),
      },
      {
        kind: 'test',
        label: 'parent bounty not active',
        testFn: async () => await childBountyParentBountyNotActiveErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'insufficient bounty balance',
        testFn: async () => await childBountyInsufficientBountyBalanceErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'invalid child bounty value',
        testFn: async () => await childBountyInvalidValueErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'invalid child bounty curator fee',
        testFn: async () => await childBountyInvalidFeeErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'accept curator when child bounty is in added state',
        testFn: async () => await childBountyUnexpectedStatusErrorTest(chain),
      },
      {
        kind: 'test',
        label: 'close child bounty in pending payout status',
        testFn: async () => await childBountyPendingPayoutErrorTest(chain),
      },
    ],
  }
}
