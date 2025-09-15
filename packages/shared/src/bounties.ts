import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 as devAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'

import { expect } from 'vitest'

import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

/**
 * Get the current bounty count
 */
async function getBountyCount(client: any): Promise<number> {
  return (await client.api.query.bounties.bountyCount()).toNumber()
}

/**
 * Get a bounty by index
 */
async function getBounty(client: any, bountyIndex: number): Promise<any | null> {
  const bounty = await client.api.query.bounties.bounties(bountyIndex)
  if (!bounty) return null
  return bounty.isSome ? bounty.unwrap() : null
}

/**
 * Get bounty description by index
 */
async function getBountyDescription(client: any, bountyIndex: number): Promise<string | null> {
  const description = await client.api.query.bounties.bountyDescriptions(bountyIndex)
  return description.isSome ? description.unwrap().toUtf8() : null
}

/**
 * Get approved bounties queue
 */
async function getBountyApprovals(client: any): Promise<number[]> {
  const approvals = await client.api.query.bounties.bountyApprovals()
  return approvals.map((index: any) => index.toNumber())
}

/**
 * Setup accounts with funds for testing
 */
async function setupTestAccounts(client: any, accounts: string[] = ['alice', 'bob']) {
  const accountMap = {
    alice: devAccounts.alice.address,
    bob: devAccounts.bob.address,
    charlie: devAccounts.charlie.address,
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
async function getBountyIndexFromEvent(client: any): Promise<number> {
  const [bountyProposedEvent] = (await client.api.query.system.events()).filter(
    ({ event }: any) => event.section === 'bounties' && event.method === 'BountyProposed',
  )
  expect(bountyProposedEvent).toBeDefined()
  return (bountyProposedEvent.event.data as any).index.toNumber()
}

/**
 * Get bounties events from the system events
 */
async function getBountyEvents(client: any): Promise<any[]> {
  const events = await client.api.query.system.events()
  return events.filter((record) => record.event.section === 'bounties')
}

/**
 *  Log the bounties events
 */
async function logBountyEvents(client: any) {
  const events = await getBountyEvents(client)
  events.forEach((evt: any, idx: number) => {
    console.log(`Event #${idx}:`, evt.event?.toHuman?.() ?? evt.event)
  })
}

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
 * Test 1: Creating a bounty
 * Propose a bounty
 * Verifies:
 * - Bounty proposal is successful
 * - Correct events are emitted
 * - Bounty data is stored correctly
 * - Bounty count increases
 */
export async function bountyCreationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Setup test accounts
  await setupTestAccounts(client, ['alice'])

  const initialBountyCount = await getBountyCount(client)

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 EDs
  const description = 'Test bounty for development work'

  // Propose a bounty
  const bountyProposalEvents = await sendTransaction(
    client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice),
  )

  await client.dev.newBlock()

  // Verify events
  await checkEvents(bountyProposalEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposal events')

  // Verify bounty count increased
  const newBountyCount = await getBountyCount(client)
  expect(newBountyCount).toBe(initialBountyCount + 1)

  // Get bounty index and verify bounty data
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty).toBeDefined()
  expect(bounty.value.toBigInt()).toBe(bountyValue)
  expect(bounty.status.isProposed).toBe(true)

  // Verify description was stored
  const storedDescription = await getBountyDescription(client, bountyIndex)
  expect(storedDescription).toBeTruthy()
  expect(storedDescription).toBe(description)

  await client.teardown()
}

/**
 * Test 2: Bounty approval flow
 *
 * Verifies:
 * - Bounty can be approved by treasurer
 * - Status changes from Proposed to Approved
 * - Bounty is added to approvals queue
 * - Correct events are emitted
 */
export async function bountyApprovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 EDs
  const description = 'Test bounty for approval'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Verify initial state
  const proposedBounty = await getBounty(client, bountyIndex)
  expect(proposedBounty.status.isProposed).toBe(true)

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify approval events
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approval events')

  // Verify status changed
  const approvedBounty = await getBounty(client, bountyIndex)
  expect(approvedBounty.status.isApproved).toBe(true)

  // Verify bounty is in approvals queue
  const approvals = await getBountyApprovals(client)
  expect(approvals).toContain(bountyIndex)

  await client.teardown()
}

/**
 * Bounty approval flow with curator
 *
 * Verifies:
 * - Bounty can be approved by treasurer with curator
 * - Status changes from Proposed to ApprovedWithCurator
 * - Bounty is added to approvals queue
 * - Correct events are emitted
 */
export async function bountyApprovalWithCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 EDs
  const curatorFee = existentialDeposit.toBigInt() * 100n // 100 EDs (10% fee)
  const description = 'Test bounty for approval with curator'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Verify initial state
  const proposedBounty = await getBounty(client, bountyIndex)
  expect(proposedBounty.status.isProposed).toBe(true)

  // Approve the bounty with curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.approveBountyWithCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

  await client.dev.newBlock()

  // Verify approval events
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approval with curator events')

  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // Verify status changed
  const approvedBounty = await getBounty(client, bountyIndex)
  expect(approvedBounty.status.isApprovedWithCurator).toBe(true)

  // Verify bounty is in approvals queue
  const approvals = await getBountyApprovals(client)
  expect(approvals).toContain(bountyIndex)

  await client.teardown()
}

/**
 * Bounty funding for Approved Bounties
 *
 * Verifies:
 * - Approved Bounties get funded by treasury automatically
 * - Status changes from Approved -> Funded
 * - Correct events are emitted
 */
export async function bountyFundingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping bounty funding test')
    return
  }

  // move client head to the last spend period block - 3
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const description = 'Test bounty for funding'

  // propose a bounty
  const bountyProposedEvents = await sendTransaction(
    client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice),
  )

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the bounty is added to the storage
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  // approve the bounty with origin treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  // TODO: @dhirajs0 - verify that the bond of the proposer is reserved and it's unreserved after the bounty is funded

  await client.teardown()
}

/**
 *  Bounty funding for ApprovedWithCurator Bounties
 *
 * Verifies:
 * - When a bounty is approved with curator, status changes to ApprovedWithCurator
 * - ApprovedWithCurator Bounties get funded by treasury automatically
 * - Status changes from ApprovedWithCurator -> CuratorProposed
 * - Correct events are emitted
 */
export async function bountyFundingForApprovedWithCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // go the block number when the last spend period block - 3
  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const curatorFee = existentialDeposit.toBigInt() * 100n // 100 tokens (10% fee)
  const description = 'Test bounty for funding with curator'

  // propose a bounty
  const bountyProposedEvents = await sendTransaction(
    client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice),
  )

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the bounty is added to the storage and the status is Proposed
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  // approve the bounty with origin treasurer with curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.approveBountyWithCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // verify the bounty is added to the approvals queue
  const approvals = await getBountyApprovals(client)
  expect(approvals).toContain(bountyIndex)

  // verify the bounty status is ApprovedWithCurator
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isApprovedWithCurator).toBe(true)

  await client.dev.newBlock()
  // In this block the bounty is funded and the status changes to CuratorProposed
  await client.dev.newBlock()

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  // verify the bounty status is CuratorProposed
  const bountyStatusAfterFunding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterFunding.status.isCuratorProposed).toBe(true)

  await client.teardown()
}

/**
 * Curator assignment and acceptance
 *
 * Verifies:
 * - Curator can be proposed for a funded bounty
 * - Status changes from Funded -> CuratorProposed
 * - Curator can accept the role
 * - Status changes from CuratorProposed -> Active
 * - Curator deposit is reserved
 * - Correct events are emitted
 */
export async function curatorAssignmentAndAcceptanceTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping bounty funding test')
    return
  }

  // move client head to the last spend period block - 3
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const description = 'Test bounty for funding'

  // propose a bounty
  const bountyProposedEvents = await sendTransaction(
    client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice),
  )

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the bounty is added to the storage
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  // approve the bounty with origin treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  const curatorFee = existentialDeposit.toBigInt() * 100n // 100 EDs (10% fee)

  // assign curator to the bounty
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
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
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the bounty status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  await client.teardown()
}

/**
 * Bounty extension
 *
 * Verifies:
 * - Curator can extend bounty expiry
 * - Update due date is extended
 * - Correct events are emitted
 */
export async function bountyExtensionTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping bounty funding test')
    return
  }

  // move client head to the last spend period block - 3
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const description = 'Test bounty for funding'

  // propose a bounty
  const bountyProposedEvents = await sendTransaction(
    client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice),
  )

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the bounty is added to the storage
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  // approve the bounty with origin treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  const curatorFee = existentialDeposit.toBigInt() * 100n // 100 EDs (10% fee)

  // assign curator to the bounty
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
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
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the bounty status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  await client.dev.newBlock()

  // log the bounty and get updateDue before extension
  const bountyForExtending = await getBounty(client, bountyIndex)

  // Get updateDue before extension
  const updateDueBefore = bountyForExtending.status.asActive.updateDue.toNumber()

  // extend the bounty expiry
  const extendBountyEvents = await sendTransaction(
    client.api.tx.bounties.extendBountyExpiry(bountyIndex, 'Testing the bounty extension').signAsync(devAccounts.bob),
  )

  await client.dev.newBlock()

  // verify the BountyExtended events
  await checkEvents(extendBountyEvents, { section: 'bounties', method: 'BountyExtended' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty extended events')

  // verify the bounty is extended and get updateDue after extension
  const bountyExtended = await getBounty(client, bountyIndex)
  expect(bountyExtended.status.isActive).toBe(true)

  // Get updateDue after extension
  const updateDueAfter = bountyExtended.status.asActive.updateDue.toNumber()

  // Assert that updateDue after extension is greater than before
  expect(updateDueAfter).toBeGreaterThan(updateDueBefore)

  await client.teardown()
}

/**
 * Bounty awarding and claiming
 *
 * Verifies:
 * - Curator can award bounty to beneficiary
 * - Status changes to PendingPayout
 * - Curator can claim the bounty after delay period
 * - Correct events are emitted
 */
export async function bountyAwardingAndClaimingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping bounty funding test')
    return
  }

  // move client head to the last spend period block - 3
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const description = 'Test bounty for funding'

  // propose a bounty
  const bountyProposedEvents = await sendTransaction(
    client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice),
  )

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the bounty is added to the storage
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  // approve the bounty with origin treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  const curatorFee = existentialDeposit.toBigInt() * 100n // 100 EDs (10% fee)

  // assign curator to the bounty
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
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
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the bounty status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  await client.dev.newBlock()

  // award the bounty to the beneficiary
  const awardBountyEvents = await sendTransaction(
    client.api.tx.bounties.awardBounty(bountyIndex, devAccounts.alice.address).signAsync(devAccounts.bob),
  )

  await client.dev.newBlock()

  // verify events
  await checkEvents(awardBountyEvents, { section: 'bounties', method: 'BountyAwarded' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty awarded events')

  // verify the bounty is awarded
  const bountyAwarded = await getBounty(client, bountyIndex)
  expect(bountyAwarded.status.isPendingPayout).toBe(true)

  // Calculate the claimable at block number
  const currentBlock = await client.api.rpc.chain.getHeader()
  const bountyDepositPayoutDelay = await client.api.consts.bounties.bountyDepositPayoutDelay
  const claimableAtBlock = currentBlock.number.toNumber() + Number(bountyDepositPayoutDelay.toNumber())

  // wait for the unlock at block number
  await client.dev.setHead(claimableAtBlock)

  await client.dev.newBlock()

  // claim the bounty
  const claimBountyEvents = await sendTransaction(
    client.api.tx.bounties.claimBounty(bountyIndex).signAsync(devAccounts.alice),
  )

  await client.dev.newBlock()

  // verify events
  await checkEvents(claimBountyEvents, { section: 'bounties', method: 'BountyClaimed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty claimed events')

  // verify that the bounty is removed from the storage
  const bountyFromStorageAfterClaiming = await getBounty(client, bountyIndex)
  expect(bountyFromStorageAfterClaiming).toBeNull()

  // verify that the bounty description is removed from the storage
  const bountyDescriptionFromStorageAfterClaiming = await getBountyDescription(client, bountyIndex)
  expect(bountyDescriptionFromStorageAfterClaiming).toBeNull()

  await client.teardown()
}

/**
 * Test: Bounty closure in Proposed state
 *
 * Verifies:
 * - Bounty can be closed by GeneralAdmin when in Proposed state
 * - Proposer's bond is slashed
 * - Bounty is removed from storage
 * - BountyRejected event is emitted
 */
export async function bountyClosureProposedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const description = 'Test bounty for closure in proposed state'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Verify bounty is in Proposed state
  const proposedBounty = await getBounty(client, bountyIndex)
  expect(proposedBounty.status.isProposed).toBe(true)

  // Close the bounty using Treasurer origin
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.closeBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify BountyRejected event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyRejected' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty rejected events')

  // verify the Slash event
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' })
    .redact({ redactKeys: /who/ })
    .toMatchSnapshot('proposer bond slashed event')

  // Verify bounty is removed from storage
  const bountyAfterClosure = await getBounty(client, bountyIndex)
  expect(bountyAfterClosure).toBeNull()

  // Verify description is removed
  const descriptionAfterClosure = await getBountyDescription(client, bountyIndex)
  expect(descriptionAfterClosure).toBeNull()

  // Verify proposer's bond was slashed
  const finalBalance = await client.api.query.system.account(devAccounts.alice.address)
  const reservedBalance = finalBalance.data.reserved.toBigInt()

  // The bond should be slashed (not returned to free balance)
  expect(reservedBalance).toBe(0n) // Reserved should be 0 after slash

  await client.teardown()
}

/**
 * Test: Bounty closure in Funded state
 *
 * Verifies:
 * - Bounty can be closed when in Funded state
 * - Funds are transferred back to treasury
 * - Bounty is removed from storage
 * - BountyCanceled event is emitted
 */
export async function bountyClosureFundedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Move to spend period
  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping bounty closure funded test')
    return
  }
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const description = 'Test bounty for closure in funded state'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  // Verify bounty is funded
  const fundedBounty = await getBounty(client, bountyIndex)
  expect(fundedBounty.status.isFunded).toBe(true)

  // get treasury balance before closure
  const treasuryAccountId = client.api.consts.treasury.potAccount.toHex()
  const treasuryAccountBeforeClosureInfo = await client.api.query.system.account(treasuryAccountId)
  const treasuryBalanceBeforeClosure = treasuryAccountBeforeClosureInfo.data.free.toBigInt()

  // Close the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.closeBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify BountyCanceled event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyCanceled' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty canceled events')

  // verify the transfer event
  await checkSystemEvents(client, { section: 'balances', method: 'Transfer' })
    .redact({ redactKeys: /from|to/ })
    .toMatchSnapshot('bounty value transfered to treasury')

  // get treasury balance after closure
  const treasuryAccountAfterClosureInfo = await client.api.query.system.account(treasuryAccountId)
  const treasuryBalanceAfterClosure = treasuryAccountAfterClosureInfo.data.free.toBigInt()
  expect(treasuryBalanceAfterClosure).toBeGreaterThan(treasuryBalanceBeforeClosure)

  await client.dev.newBlock()

  // Verify bounty is removed from storage
  const bountyAfterClosure = await getBounty(client, bountyIndex)
  expect(bountyAfterClosure).toBeNull()

  // Verify description is removed
  const descriptionAfterClosure = await getBountyDescription(client, bountyIndex)
  expect(descriptionAfterClosure).toBeNull()

  await client.teardown()
}

/// -------
/// Test Suite
/// -------

export function baseBountiesE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'Creating a bounty',
        testFn: async () => await bountyCreationTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty approval flow',
        testFn: async () => await bountyApprovalTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty approval flow with curator',
        testFn: async () => await bountyApprovalWithCuratorTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty funding for Approved Bounties',
        testFn: async () => await bountyFundingTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty funding for ApprovedWithCurator Bounties',
        testFn: async () => await bountyFundingForApprovedWithCuratorTest(chain),
      },
      {
        kind: 'test',
        label: 'Curator assignment and acceptance',
        testFn: async () => await curatorAssignmentAndAcceptanceTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty extension',
        testFn: async () => await bountyExtensionTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty awarding and claiming',
        testFn: async () => await bountyAwardingAndClaimingTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty closure in proposed state',
        testFn: async () => await bountyClosureProposedTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty closure in funded state',
        testFn: async () => await bountyClosureFundedTest(chain),
      },
    ],
  }
}
