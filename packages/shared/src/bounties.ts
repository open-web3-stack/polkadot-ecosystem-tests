import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 as devAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

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
  assert(client.api.events.bounties.BountyProposed.is(bountyProposedEvent.event))
  return bountyProposedEvent.event.data.index.toNumber()
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

/**
 * Test: Bounty closure in Active state
 *
 * Verifies:
 * - Bounty can be closed when in Active state
 * - Curator deposit is refunded
 * - Funds are transferred back to treasury
 * - Bounty is removed from storage
 * - BountyCanceled event is emitted
 */
export async function bountyClosureActiveTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping bounty closure active test')
    return
  }

  // Move to spend period
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for closure in active state'

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

  // Propose a curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // Accept curator role
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // Verify bounty is in Active state
  const activeBounty = await getBounty(client, bountyIndex)
  expect(activeBounty.status.isActive).toBe(true)

  // Get curator reserved balance before closure
  const curatorBalanceBeforeClosure = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceBeforeClosure = curatorBalanceBeforeClosure.data.reserved.toBigInt()

  // Close the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.closeBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify BountyCanceled event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyCanceled' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty canceled event')

  // verify the curator transfer of balance event to the treasury
  await checkSystemEvents(client, { section: 'balances', method: 'Transfer' })
    .redact({ redactKeys: /from|to/ })
    .toMatchSnapshot('Bounty value is transferred to the treasury')

  // Verify bounty is removed from storage
  const bountyAfterClosure = await getBounty(client, bountyIndex)
  expect(bountyAfterClosure).toBeNull()

  // Verify curator deposit was refunded
  const curatorBalanceAfterClosure = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceAfterClosure = curatorBalanceAfterClosure.data.reserved.toBigInt()
  expect(curatorReservedBalanceBeforeClosure).toBeGreaterThan(curatorReservedBalanceAfterClosure)

  await client.teardown()
}

/**
 * Test: Unassign curator in ApprovedWithCurator state
 *
 * Verifies:
 * - Treasurer can unassign curator from ApprovedWithCurator state
 * - Status changes back to Approved
 * - CuratorUnassigned event is emitted
 */
export async function unassignCuratorApprovedWithCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for unassign curator in approved with curator state'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve bounty with curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.approveBountyWithCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // Verify bounty is in ApprovedWithCurator state
  const approvedWithCuratorBounty = await getBounty(client, bountyIndex)
  expect(approvedWithCuratorBounty.status.isApprovedWithCurator).toBe(true)

  // Unassign curator using Treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.unassignCurator(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned approved with curator events')

  // Verify bounty status changed back to Approved
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isApproved).toBe(true)

  await client.teardown()
}

/**
 * Test: Unassign curator in CuratorProposed state
 *
 * Verifies:
 * - Treasurer can unassign curator from CuratorProposed state
 * - Status changes to Funded
 * - CuratorUnassigned event is emitted
 */
export async function unassignCuratorCuratorProposedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping unassign curator curator proposed test')
    return
  }

  // Move to spend period
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for unassign curator in curator proposed state'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // verify status of the bounty
  const bountyStatusAfterProposal = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterProposal.status.isProposed).toBe(true)

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  // verify status of the bounty
  const bountyStatusAfterApproval = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterApproval.status.isApproved).toBe(true)

  await client.dev.newBlock()
  // Bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  const bountyStatusAfterFunding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterFunding.status.isFunded).toBe(true)

  // Propose a curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // Verify bounty is in CuratorProposed state
  const curatorProposedBounty = await getBounty(client, bountyIndex)
  expect(curatorProposedBounty.status.isCuratorProposed).toBe(true)

  // Unassign curator using Treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.unassignCurator(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned curator proposed events')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)

  await client.teardown()
}

/**
 * Test: Unassign curator in Active state by curator themselves
 *
 * Verifies:
 * - Curator can unassign themselves from Active state
 * - Curator deposit is refunded
 * - Status changes to Funded
 * - CuratorUnassigned event is emitted
 */
export async function unassignCuratorActiveByCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping unassign curator active by curator test')
    return
  }

  // Move to spend period
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for unassign curator active by curator'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // verify the status is Proposed
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isProposed).toBe(true)

  // verify the BountyProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  // verify the status is Approved
  const bountyStatusAfterApproval = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterApproval.status.isApproved).toBe(true)

  await client.dev.newBlock()
  // Bounty will be funded in this block

  // verify the event BountyBecameActive
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // verify the status is Funded
  const bountyStatusAfterFunding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterFunding.status.isFunded).toBe(true)

  // Propose a curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // verify the status is CuratorProposed
  const bountyStatusAfterCuratorProposed = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorProposed.status.isCuratorProposed).toBe(true)

  // Accept curator role
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Get curator reserved balance before unassign
  const curatorBalanceBefore = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceBefore = curatorBalanceBefore.data.reserved.toBigInt()

  // Unassign curator by curator themselves
  await sendTransaction(client.api.tx.bounties.unassignCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned active by curator events')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)

  // Verify curator deposit was refunded as the caller is the curator so dont slash the curator
  const curatorBalanceAfter = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceAfter = curatorBalanceAfter.data.reserved.toBigInt()
  expect(curatorReservedBalanceAfter).toBeLessThan(curatorReservedBalanceBefore)

  await client.teardown()
}

/**
 * Test: Unassign curator in Active state by Treasurer (slashes curator)
 *
 * Verifies:
 * - Treasurer can unassign curator from Active state
 * - Curator deposit is slashed
 * - Status changes to Funded
 * - CuratorUnassigned event is emitted
 */
export async function unassignCuratorActiveByTreasurerTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping unassign curator active by treasurer test')
    return
  }

  // Move to spend period
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for unassign curator active by treasurer'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  // verify the status is Proposed
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isProposed).toBe(true)

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  // verify the status is Approved
  const bountyStatusAfterApproval = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterApproval.status.isApproved).toBe(true)

  await client.dev.newBlock()
  // Bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // verify the status is Funded
  const bountyStatusAfterFunding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterFunding.status.isFunded).toBe(true)

  // Propose a curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // verify the status is CuratorProposed
  const bountyStatusAfterCuratorProposed = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorProposed.status.isCuratorProposed).toBe(true)

  // Accept curator role
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Get curator balance before unassign
  const curatorBalanceBefore = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceBefore = curatorBalanceBefore.data.reserved.toBigInt()

  // Unassign curator by Treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.unassignCurator(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned active by treasurer events')

  // verify the curator slash event as the unassignCurator is called by the treasurer
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' })
    .redact({ redactKeys: /who/ })
    .toMatchSnapshot('curator slash event')

  // verify that the slashed amout is deposited to the treasury
  await checkSystemEvents(client, { section: 'treasury', method: 'Deposit' })
    .redact({ redactKeys: /data/ })
    .toMatchSnapshot('Bounty bond is deposited to the treasury')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)

  // Verify curator deposit was slashed
  const curatorBalanceAfter = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceAfter = curatorBalanceAfter.data.reserved.toBigInt()
  expect(curatorReservedBalanceBefore).toBeGreaterThan(curatorReservedBalanceAfter)

  await client.teardown()
}

/**
 * Test: Unassign curator in PendingPayout state by Treasurer
 *
 * Verifies:
 * - Treasurer can unassign curator from PendingPayout state
 * - Curator deposit is slashed
 * - Status changes to Funded
 * - CuratorUnassigned event is emitted
 */
export async function unassignCuratorPendingPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping unassign curator pending payout test')
    return
  }

  // Move to spend period
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for unassign curator pending payout'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty proposed events')

  const bountyIndex = await getBountyIndexFromEvent(client)

  // verify the status is Proposed
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isProposed).toBe(true)

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  // verify the status is Approved
  const bountyStatusAfterApproval = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterApproval.status.isApproved).toBe(true)

  await client.dev.newBlock()
  // Bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // verify the status is Funded
  const bountyStatusAfterFunding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterFunding.status.isFunded).toBe(true)

  // Propose a curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // verify the status is CuratorProposed
  const bountyStatusAfterCuratorProposed = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorProposed.status.isCuratorProposed).toBe(true)

  // Accept curator role
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Award the bounty
  await sendTransaction(
    client.api.tx.bounties.awardBounty(bountyIndex, devAccounts.alice.address).signAsync(devAccounts.bob),
  )

  await client.dev.newBlock()

  // verify the BountyAwarded event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyAwarded' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty awarded events')

  // verify the status is PendingPayout
  const bountyStatusAfterAwarding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterAwarding.status.isPendingPayout).toBe(true)

  // Get curator reserved balance before unassign
  const curatorBalanceBefore = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceBefore = curatorBalanceBefore.data.reserved.toBigInt()

  // Unassign curator by Treasurer
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.unassignCurator(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned pending payout events')

  // verify the curator slash event as the unassignCurator is called by the treasurer
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' })
    .redact({ redactKeys: /who/ })
    .toMatchSnapshot('curator slash event')

  // verify that the slashed amout is deposited to the treasury
  await checkSystemEvents(client, { section: 'treasury', method: 'Deposit' })
    .redact({ redactKeys: /data/ })
    .toMatchSnapshot('Bounty bond is deposited to the treasury')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)

  // Verify curator reserved balance was slashed
  const curatorBalanceAfter = await client.api.query.system.account(devAccounts.bob.address)
  const curatorReservedBalanceAfter = curatorBalanceAfter.data.reserved.toBigInt()
  expect(curatorReservedBalanceBefore).toBeGreaterThan(curatorReservedBalanceAfter)

  await client.teardown()
}

/// -------
/// Test Suite
/// -------

/**
 * Bounty Closure Tests
 * @param chain
 * @returns RootTestTree
 */
export function bountyClosureTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty Closure Tests',
    children: [
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
      {
        kind: 'test',
        label: 'Bounty closure in active state',
        testFn: async () => await bountyClosureActiveTest(chain),
      },
    ],
  } as RootTestTree
}

/**
 * All curator unassign tests
 * @param chain
 * @returns RootTestTree
 */
export function allCuratorUnassignTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All curator unassign tests',
    children: [
      {
        kind: 'test',
        label: 'Unassign curator in ApprovedWithCurator state',
        testFn: async () => await unassignCuratorApprovedWithCuratorTest(chain),
      },
      {
        kind: 'test',
        label: 'Unassign curator in CuratorProposed state',
        testFn: async () => await unassignCuratorCuratorProposedTest(chain),
      },
      {
        kind: 'test',
        label: 'Unassign curator in Active state by curator themselves',
        testFn: async () => await unassignCuratorActiveByCuratorTest(chain),
      },
      {
        kind: 'test',
        label: 'Unassign curator in Active state by Treasurer',
        testFn: async () => await unassignCuratorActiveByTreasurerTest(chain),
      },
      {
        kind: 'test',
        label: 'Unassign curator in PendingPayout state',
        testFn: async () => await unassignCuratorPendingPayoutTest(chain),
      },
    ],
  } as RootTestTree
}

/**
 * Test: Bounty closure in Approved state (should fail)
 *
 * Verifies:
 * - Bounty closure fails with UnexpectedStatus when in Approved state (GeneralAdmin cannot close approved bounties)
 * - Bounty remains in storage
 */
export async function bountyClosureApprovedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const description = 'Test bounty for closure in approved state'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Verify bounty is in Approved state
  const approvedBounty = await getBounty(client, bountyIndex)
  expect(approvedBounty.status.isApproved).toBe(true)

  // Try to close the bounty - should fail
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.closeBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('scheduler events when closing bounty with approved state fails')

  // check he result of dispatched event
  const events = await client.api.query.system.events()

  // Find the Dispatched event from scheduler
  const dispatchedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'Dispatched'
  })

  assert(dispatchedEvent)
  assert(client.api.events.scheduler.Dispatched.is(dispatchedEvent.event))

  const dispatchedData = dispatchedEvent.event.data
  expect(dispatchedData.result.isErr).toBe(true)

  // Decode the module error to get human-readable details
  const dispatchError = dispatchedData.result.asErr
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.UnexpectedStatus.is(dispatchError.asModule)).toBeTruthy()

  // Verify bounty is still in storage and still Approved
  const bountyAfterFailedClosure = await getBounty(client, bountyIndex)
  expect(bountyAfterFailedClosure).toBeDefined()
  expect(bountyAfterFailedClosure.status.isApproved).toBe(true)

  await client.teardown()
}

/**
 * Test: Bounty closure in PendingPayout state (should fail)
 *
 * Verifies:
 * - Bounty closure fails with PendingPayout error when in PendingPayout state (GeneralAdmin must unassign curator first)
 * - Bounty remains in storage
 */
export async function bountyClosurePendingPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping bounty closure pending payout test')
    return
  }

  // Move to spend period
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for closure in pending payout state'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // Approve the bounty
  const bountyIndex = await getBountyIndexFromEvent(client)
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  // Propose a curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // Accept curator role
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // Award the bounty
  await sendTransaction(
    client.api.tx.bounties.awardBounty(bountyIndex, devAccounts.alice.address).signAsync(devAccounts.bob),
  )

  await client.dev.newBlock()

  // Verify bounty is in PendingPayout state
  const pendingPayoutBounty = await getBounty(client, bountyIndex)
  expect(pendingPayoutBounty.status.isPendingPayout).toBe(true)

  // Try to close the bounty - should fail
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.closeBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('scheduler events when closing bounty with pending payout fails')

  const events = await client.api.query.system.events()

  const dispatchedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'Dispatched'
  })

  assert(dispatchedEvent)
  assert(client.api.events.scheduler.Dispatched.is(dispatchedEvent.event))

  const dispatchedData = dispatchedEvent.event.data
  expect(dispatchedData.result.isErr).toBe(true)

  const dispatchError = dispatchedData.result.asErr
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.PendingPayout.is(dispatchError.asModule)).toBeTruthy()

  // Verify bounty is still in storage and still PendingPayout
  const bountyAfterFailedClosure = await getBounty(client, bountyIndex)
  expect(bountyAfterFailedClosure).toBeDefined()
  expect(bountyAfterFailedClosure.status.isPendingPayout).toBe(true)

  await client.teardown()
}

/**
 * Test that unassigning curator in Active state by public fails with `Premature`.
 *
 * 1. Alice proposes a bounty, it gets approved, curator is proposed and accepted
 * 2. Public user attempts to unassign curator immediately (before proper timing)
 * 3. Verify that the transaction fails with the appropriate error
 */
async function unassignCuratorActiveStateByPublicPrematureTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // move to spend period
  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping unassign curator active state by public premature test')
    return
  }
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const curatorFee = existentialDeposit.toBigInt() * 100n
  const description = 'Test bounty for premature unassign curator by public'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // Approve the bounty
  const bountyIndex = await getBountyIndexFromEvent(client)
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  // Propose Bob as curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

  await client.dev.newBlock()

  // Bob accepts curator role
  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // Verify bounty is in Active state
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isActive).toBe(true)

  // Charlie (public user) tries to unassign curator immediately (premature)
  // Using scheduleInlineCallWithOrigin to simulate public call
  await sendTransaction(client.api.tx.bounties.unassignCurator(bountyIndex).signAsync(devAccounts.charlie))

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
  expect(client.api.errors.bounties.Premature.is(dispatchError.asModule)).toBeTruthy()

  // Verify bounty is still in storage and still Active
  const bountyAfterFailedUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterFailedUnassign).toBeDefined()
  expect(bountyAfterFailedUnassign.status.isActive).toBe(true)

  await client.teardown()
}

/**
 * Test that proposing a bounty with description too long fails with `ReasonTooBig`.
 *
 * 1. Alice attempts to propose a bounty with a description that exceeds the maximum length
 * 2. Verify that the transaction fails with the appropriate error
 */
async function reasonTooBigTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const maxReasonLength = client.api.consts.bounties.maximumReasonLength.toNumber()

  // Create a description that exceeds the maximum length
  const longDescription = 'x'.repeat(maxReasonLength + 1000)

  const proposeTx = client.api.tx.bounties.proposeBounty(bountyValue, longDescription)

  await sendTransaction(proposeTx.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.ReasonTooBig.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test that proposing a bounty with value below minimum fails with `InvalidValue`.
 *
 * 1. Alice attempts to propose a bounty with value below the minimum required
 * 2. Verify that the transaction fails with the appropriate error
 */
async function invalidValueTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const description = 'Test bounty with invalid value'

  // Use a value below the minimum
  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const invalidValue = bountyValueMinimum - existentialDeposit.toBigInt()

  const proposeTx = client.api.tx.bounties.proposeBounty(invalidValue, description)

  await sendTransaction(proposeTx.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
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
 * Test that approving a non-existent bounty fails with `InvalidIndex`.
 *
 * 1. Treasurer attempts to approve a bounty that doesn't exist
 * 2. Verify that the transaction fails with the appropriate error
 */
async function invalidIndexApprovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const nonExistentBountyIndex = 999

  await setupTestAccounts(client, ['alice'])

  // approve transaction with origin treasurer
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.approveBounty(nonExistentBountyIndex).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

  await client.dev.newBlock()

  // Check for scheduler Dispatched event
  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'Dispatched'
  })

  assert(client.api.events.scheduler.Dispatched.is(ev.event))
  const dispatchError = ev.event.data.result.asErr

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidIndex.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test that proposing a curator for a non-funded bounty fails with `UnexpectedStatus`.
 *
 * 1. Alice proposes a bounty
 * 2. Treasurer attempts to propose a curator before the bounty is funded
 * 3. Verify that the transaction fails with the appropriate error
 */
async function unexpectedStatusProposeCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const description = 'Test bounty for curator proposal'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // propose curator by Treasurer
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, 1000n).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

  await client.dev.newBlock()

  // Check for scheduler Dispatched event
  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'Dispatched'
  })

  assert(client.api.events.scheduler.Dispatched.is(ev.event))
  const dispatchError = ev.event.data.result.asErr

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.UnexpectedStatus.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test that a non-curator trying to accept curator role fails with `RequireCurator`.
 *
 * 1. Alice proposes a bounty and treasurer proposes Bob as curator
 * 2. Charlie attempts to accept the curator role (should be Bob)
 * 3. Verify that the transaction fails with the appropriate error
 */
async function requireCuratorAcceptTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // move client head to the last spend period block
  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping curator assignment test')
    return
  }
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 3)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n
  const description = 'Test bounty for curator requirement'

  // Propose a bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  // Propose Bob as curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, 1000n).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

  await client.dev.newBlock()

  // Charlie tries to accept curator role (should be Bob)
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)

  await sendTransaction(acceptCuratorTx.signAsync(devAccounts.charlie))

  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.RequireCurator.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * All the failure cases for bounty
 *
 * @param chain
 * @returns RootTestTree
 */
export function allBountyFailureTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All bounty failure tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty closure in approved state',
        testFn: async () => await bountyClosureApprovedTest(chain),
      },
      {
        kind: 'test',
        label: 'Bounty closure in pending payout state',
        testFn: async () => await bountyClosurePendingPayoutTest(chain),
      },
      {
        kind: 'test',
        label: 'Unassign curator in active state by public premature',
        testFn: async () => await unassignCuratorActiveStateByPublicPrematureTest(chain),
      },
      {
        kind: 'test',
        label: 'Reason too big',
        testFn: async () => await reasonTooBigTest(chain),
      },
      {
        kind: 'test',
        label: 'Invalid value',
        testFn: async () => await invalidValueTest(chain),
      },
      {
        kind: 'test',
        label: 'Invalid bounty index approval',
        testFn: async () => await invalidIndexApprovalTest(chain),
      },
      {
        kind: 'test',
        label: 'Unexpected status when proposing curator before bounty is funded',
        testFn: async () => await unexpectedStatusProposeCuratorTest(chain),
      },
      {
        kind: 'test',
        label: 'Non-curator trying to accept curator role',
        testFn: async () => await requireCuratorAcceptTest(chain),
      },
    ],
  } as RootTestTree
}

/**
 * Bounty approval tests
 *
 * @param chain
 * @returns RootTestTree
 */
export function bountyApprovalTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty approval tests',
    children: [
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
    ],
  } as RootTestTree
}

/**
 * Bounty funding tests
 *
 * @param chain
 * @returns RootTestTree
 */

export function bountyFundingTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty funding tests',
    children: [
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
    ],
  } as RootTestTree
}

/**
 *
 * All success cases for bounty
 *
 * @param chain
 * @returns RootTestTree
 */
export function allBountySuccessTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All bounty success tests',
    children: [
      {
        kind: 'test',
        label: 'Creating a bounty',
        testFn: async () => await bountyCreationTest(chain),
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
      bountyFundingTests(chain),
      bountyApprovalTests(chain),
      bountyClosureTests(chain),
      allCuratorUnassignTests(chain),
    ],
  } as RootTestTree
}

/**
 * Base set of bounty end-to-end tests.
 *
 * Includes both success and failure cases.
 * A test tree structure allows some extensibility in case a chain needs to
 * change/add/remove default tests.
 */

export function baseBountiesE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [allBountyFailureTests(chain), allBountySuccessTests(chain)],
  }
}
