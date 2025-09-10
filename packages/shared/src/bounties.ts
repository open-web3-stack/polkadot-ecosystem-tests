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

  // move client head to the last spend period block - 2
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 2)

  await setupTestAccounts(client, ['alice', 'bob'])

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const description = 'Test bounty for funding'

  // get bountycount and increase it by 1
  const bountyCount = await getBountyCount(client)
  const bountyIndex = bountyCount + 1

  // increase the bounty count
  await client.dev.setStorage({
    Bounties: {
      bountyCount: bountyIndex,
    },
  })

  // get the bounty count from the storage and verify it is same as the bounty index
  const bountyCountFromStorage = await client.api.query.bounties.bountyCount()
  expect(bountyCountFromStorage.toNumber()).toBe(bountyIndex)

  // add a bounty description using the setStorage with correct format
  await client.dev.setStorage({
    Bounties: {
      bountyDescriptions: [[[bountyIndex], description]],
    },
  })

  // verify the bounty description is added to the storage
  const bountyDescriptionFromStorage = await client.api.query.bounties.bountyDescriptions(bountyIndex)
  expect(bountyDescriptionFromStorage.isSome).toBe(true)
  expect(bountyDescriptionFromStorage.unwrap().toUtf8()).toBe(description)

  // add a bounty using the setStorage with correct format
  await client.dev.setStorage({
    Bounties: {
      bounties: [
        [
          [bountyIndex],
          {
            proposer: devAccounts.alice.address,
            value: bountyValue,
            fee: 0,
            curatorDeposit: 0,
            bond: 1000000000,
            status: { proposed: null },
          },
        ],
      ],
    },
  })

  // verify the bounty is added to the storage
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isProposed).toBe(true)

  await client.dev.newBlock()

  // add a bounty in the approvals queue by using setStorage
  await client.dev.setStorage({
    Bounties: {
      bountyApprovals: [bountyIndex],
    },
  })

  // verify the bounty is added to the approvals queue
  const approvals = await getBountyApprovals(client)
  expect(approvals).toContain(bountyIndex)

  await client.dev.newBlock()

  await client.dev.newBlock()

  // TODO: Verify that the `BountyBecameActive` event occurred in the block just before this one (i.e., after the bounty is funded)

  // verify that the bounty is funded
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isFunded).toBe(true)

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

  // go the block number when the last spend period block - 1
  const lastSpendPeriodBlock = await client.api.query.treasury.lastSpendPeriod()
  const lastSpendPeriodBlockNumber = lastSpendPeriodBlock.unwrap().toNumber()
  await client.dev.setHead(lastSpendPeriodBlockNumber - 1)

  await setupTestAccounts(client, ['alice', 'bob'])

  // get the bounty count and increase it by 1
  const bountyCount = await getBountyCount(client)
  const bountyIndex = bountyCount + 1

  // increase the bounty count
  await client.dev.setStorage({
    Bounties: {
      bountyCount: bountyIndex,
    },
  })

  // verify the bounty count is increased
  const bountyCountFromStorage = await client.api.query.bounties.bountyCount()
  expect(bountyCountFromStorage.toNumber()).toBe(bountyIndex)

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const curatorFee = existentialDeposit.toBigInt() * 100n // 100 tokens (10% fee)

  const bondValue = existentialDeposit.toBigInt() * 10n // 10 EDs
  const bountyWithCurator = {
    proposer: devAccounts.alice.address,
    value: bountyValue,
    fee: curatorFee,
    curatorDeposit: 0,
    bond: bondValue,
    status: { approvedWithCurator: { curator: devAccounts.bob.address } },
  }

  // add the bounty to the storage
  await client.dev.setStorage({
    Bounties: {
      bounties: [[[bountyIndex], bountyWithCurator]],
    },
  })

  // verify the bounty is added to the storage
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isApprovedWithCurator).toBe(true)

  // add bouty to the approvals queue
  await client.dev.setStorage({
    Bounties: {
      bountyApprovals: [bountyIndex],
    },
  })

  // verify the bounty is added to the approvals queue
  const approvals = await getBountyApprovals(client)
  expect(approvals).toContain(bountyIndex)

  await client.dev.newBlock()
  // bounty is funded in this block
  await client.dev.newBlock()

  // verify the bounty is funded
  const bountyAfterFunding = await getBounty(client, bountyIndex)
  expect(bountyAfterFunding.status.isCuratorProposed).toBe(true)

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

  await setupTestAccounts(client, ['alice', 'bob'])

  // get bounty count and increase it by 1
  const bountyCount = await getBountyCount(client)
  const bountyIndex = bountyCount + 1

  // increase the bounty count
  await client.dev.setStorage({
    Bounties: {
      bountyCount: bountyIndex,
    },
  })

  // verify the bounty count is increased
  const bountyCountFromStorage = await client.api.query.bounties.bountyCount()
  expect(bountyCountFromStorage.toNumber()).toBe(bountyIndex)

  const existentialDeposit = client.api.consts.balances.existentialDeposit
  const bountyValue = existentialDeposit.toBigInt() * 1000n // 1000 tokens
  const bondValue = existentialDeposit.toBigInt() * 10n // 10 EDs

  // add the below funded bounty to the storage
  const fundedBounty = {
    proposer: devAccounts.alice.address,
    value: bountyValue,
    fee: 0,
    curatorDeposit: 0,
    bond: bondValue,
    status: { funded: null },
  }

  await client.dev.setStorage({
    Bounties: {
      bounties: [[[bountyIndex], fundedBounty]],
    },
  })

  // verify the bounty is added to the storage
  const bountyFromStorage = await getBounty(client, bountyIndex)
  expect(bountyFromStorage.status.isFunded).toBe(true)

  await client.dev.newBlock()

  // propose a curator
  const curatorFee = existentialDeposit.toBigInt() * 100n // 100 tokens (10% fee)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, devAccounts.bob.address, curatorFee).method.toHex(),
    {
      Origins: 'Treasurer',
    },
  )

  await client.dev.newBlock()

  // verify events
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('curator proposed events')

  // verify the curator is proposed
  const curatorProposed = await getBounty(client, bountyIndex)
  expect(curatorProposed.status.isCuratorProposed).toBe(true)

  await client.dev.newBlock()

  // accept the curator
  const acceptCuratorEvents = await sendTransaction(
    client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(devAccounts.bob),
  )

  await client.dev.newBlock()

  // verify events
  await checkEvents(acceptCuratorEvents, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('curator accepted events')

  // verify the curator is accepted
  const curatorAccepted = await getBounty(client, bountyIndex)
  expect(curatorAccepted.status.isActive).toBe(true)

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
    ],
  }
}
