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
    ],
  }
}
