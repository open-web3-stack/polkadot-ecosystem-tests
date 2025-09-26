import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin, TestConfig } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// multipliers for the bounty and curator fee
const BOUNTY_MULTIPLIER = 1000n
const CURATOR_FEE_MULTIPLIER = 100n

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
async function setupTestAccounts(client: Client<any, any>, accounts: string[] = ['alice', 'bob', 'charlie']) {
  const accountMap = {
    alice: testAccounts.alice.address,
    bob: testAccounts.bob.address,
    charlie: testAccounts.charlie.address,
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
 * Ensure the spend period is available
 */
async function ensureSpendPeriodAvailable(lastSpendPeriodBlock: any): Promise<boolean> {
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping test')
    return false
  }
  return true
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
 * Test basic child bounty from parent bounty.
 *
 * 1. Alice creates a parent bounty
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
  const bountyProposedEvents = await sendTransaction(
    client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(testAccounts.alice),
  )

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
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
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
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

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
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the bounty status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Note: The curator (Bob) should create the child bounty, not Alice
  const childBountyValue = existentialDeposit.toBigInt() * CURATOR_FEE_MULTIPLIER // Smaller value for child bounty
  const childBountyDescription = 'Test child bounty'

  await sendTransaction(
    client.api.tx.childBounties
      .addChildBounty(bountyIndex, childBountyValue, childBountyDescription)
      .signAsync(testAccounts.bob), // Bob is the curator, so he should create the child bounty
  )

  await client.dev.newBlock()

  // Check for ChildBountyAdded event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Added' })
    .redact({ redactKeys: /index|data/ })
    .toMatchSnapshot('child bounty added events')

  await logAllEvents(client)

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
        label: 'child bounty creation test',
        testFn: async () => await childBountyCreationTest(chain),
      },
    ],
  }
}
