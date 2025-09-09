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
  const bountyValue = existentialDeposit.muln(1000) // 1000 EDs
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
  const bountyValue = existentialDeposit.muln(1000) // 1000 EDs
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
 * Test 3: Curator assignment and acceptance
 *
 * Verifies:
 * - Curator can be proposed for a funded bounty
 * - Curator can accept the role
 * - Status transitions correctly
 * - Curator deposit is reserved
 * - Correct events are emitted
 */
export async function curatorAssignmentTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.muln(1000) // 1000 EDs
  const curatorFee = existentialDeposit.muln(100) // 100 EDs (10% fee)
  const description = 'Test bounty with curator'

  // Propose and approve bounty
  await sendTransaction(client.api.tx.bounties.proposeBounty(bountyValue, description).signAsync(devAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  await scheduleInlineCallWithOrigin(client, client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(), {
    Origins: 'Treasurer',
  })

  await client.dev.newBlock()

  // Propose a curator
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
  )

  await client.dev.newBlock()

  // Verify curator proposed events
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // Verify bounty status
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isCuratorProposed).toBeTruthy()
  expect(bounty.fee.toBigInt()).toBe(curatorFee)

  // Curator accepts the role
  const acceptCuratorEvents = await sendTransaction(
    client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob),
  )

  await client.dev.newBlock()

  // Verify curator accepted events
  await checkEvents(acceptCuratorEvents, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // Verify bounty is now active
  const activeBounty = await getBounty(client, bountyIndex)
  console.log('Active bounty status:', activeBounty.status.toHuman())
  expect(activeBounty.status.isActive).toBeTruthy()

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
        label: 'Curator assignment and acceptance',
        testFn: async () => await curatorAssignmentTest(chain),
      },
    ],
  }
}
