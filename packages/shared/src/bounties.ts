import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

import {
  checkEvents,
  checkSystemEvents,
  getBlockNumber,
  scheduleInlineCallWithOrigin,
  schedulerOffset,
  type TestConfig,
} from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// initial funding balance for accounts
const TEST_ACCOUNT_BALANCE_MULTIPLIER = 100_000n // 100_000x existential deposit

const NON_EXISTENT_BOUNTY_INDEX = 999 // randombounty index that doesn't exist

// 4 blocks before the spend period block
const TREASURY_SETUP_OFFSET = 4

// multipliers for the bounty and curator fee
const BOUNTY_MULTIPLIER = 1000n // 1000x existential deposit for substantial bounty value
const CURATOR_FEE_MULTIPLIER = 100n // 10% curator fee (100/1000)

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
async function setupTestAccounts(client: Client<any, any>, accounts: string[] = ['alice', 'bob']) {
  const accountMap = {
    alice: testAccounts.alice.address,
    bob: testAccounts.bob.address,
    charlie: testAccounts.charlie.address,
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
 * Get bounty index from `BountyProposed` event
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
 * Sets the treasury's last spend period block number to enable bounty funding
 * @param client - The chain client
 */
async function setLastSpendPeriodBlockNumber(client: Client<any, any>, testConfig: TestConfig) {
  const spendPeriod = client.api.consts.treasury.spendPeriod
  const currentBlock = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)

  const newLastSpendPeriodBlockNumber = currentBlock - spendPeriod.toNumber() + TREASURY_SETUP_OFFSET * offset
  await client.dev.setStorage({
    Treasury: {
      lastSpendPeriod: newLastSpendPeriodBlockNumber,
    },
  })

  // ensure the last spend period block number is updated in storage
  const fetchedLastSpendPeriodBlockNumber = await client.api.query.treasury.lastSpendPeriod()
  expect(fetchedLastSpendPeriodBlockNumber.unwrap().toNumber()).toBe(newLastSpendPeriodBlockNumber)
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
 * Test: Bounty Creation
 *
 * This test verifies that users can successfully propose bounties to the treasury system.
 * Bounty proposals are the foundation of the bounty workflow and must correctly store
 * proposal data, emit appropriate events, and increment the bounty counter.
 *
 * The test achieves this by:
 * - Having `Alice` propose a bounty with a substantial value and description
 * - Verifying the `BountyProposed` event is emitted with correct data
 * - Checking that the bounty count increases by one
 * - Confirming the bounty data is properly stored in chain state
 * - Validating the bounty description is correctly saved
 */
export async function bountyCreationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Setup test accounts
  await setupTestAccounts(client, ['alice'])

  const initialBountyCount = await getBountyCount(client)

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for development work'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposalEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  expect(bounty).toBeTruthy()
  expect(bounty.value.toBigInt()).toBe(bountyValue)
  expect(bounty.status.isProposed).toBe(true)

  // Verify description was stored
  const storedDescription = await getBountyDescription(client, bountyIndex)
  expect(storedDescription).toBeTruthy()
  expect(storedDescription).toBe(description)

  await client.teardown()
}

/**
 * Test: Bounty Approval Flow
 *
 * This test verifies that treasury administrators can approve bounty proposals,
 * transitioning them from the proposed state to the approved state. This is
 * a critical governance step that ensures only legitimate bounties receive funding.
 *
 * The test achieves this by:
 * - Having Alice propose a bounty
 * - Using the `Treasurer` origin to approve the bounty
 * - Verifying the status changes from `Proposed` to `Approved`
 * - Confirming the bounty is added to the approvals queue
 * - Checking that appropriate `BountyApproved` events are emitted
 */
export async function bountyApprovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for approval'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Verify initial state
  const proposedBounty = await getBounty(client, bountyIndex)
  expect(proposedBounty.status.isProposed).toBe(true)

  // Approve the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
 * Test: Bounty Approval with Curator Assignment
 *
 * This test verifies that treasury administrators can approve bounty proposals
 * while simultaneously assigning a curator. This streamlines the workflow by
 * combining approval and curator assignment into a single operation, reducing
 * the number of transactions needed to activate a bounty.
 *
 * The test achieves this by:
 * - Having Alice propose a bounty
 * - Using the `Treasurer` origin to approve the bounty with a curator
 * - Verifying the status changes from `Proposed` to `ApprovedWithCurator`
 * - Confirming the bounty is added to the approvals queue
 * - Checking that both `BountyApproved` and `CuratorProposed` events are emitted
 */
export async function bountyApprovalWithCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const minimumBounty = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = minimumBounty.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = minimumBounty.toBigInt() * CURATOR_FEE_MULTIPLIER // 10% fee
  const description = 'Test bounty for approval with curator'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Verify initial state
  const proposedBounty = await getBounty(client, bountyIndex)
  expect(proposedBounty.status.isProposed).toBe(true)

  // Approve the bounty with curator
  const approveBountyWithCuratorTx = client.api.tx.bounties.approveBountyWithCurator(
    bountyIndex,
    testAccounts.bob.address,
    curatorFee,
  )
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyWithCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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
 * Test: Automatic Bounty Funding for `Approved` Bounties
 *
 * This test verifies that approved bounties are automatically funded by the
 * treasury during the spend period. This ensures that approved bounties receive
 * their allocated funds without manual intervention, maintaining the automated
 * nature of the bounty system.
 *
 * The test achieves this by:
 * - Setting up the treasury spend period timing
 * - Having Alice propose and get a bounty approved
 * - Advancing blocks to trigger the spend period
 * - Verifying the bounty status changes from `Approved` to `Funded`
 * - Confirming the `BountyBecameActive` event is emitted
 */
export async function bountyFundingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for funding'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  await client.teardown()
}

/**
 * Test: Automatic Bounty Funding for `ApprovedWithCurator` Bounties
 *
 * This test verifies that bounties approved with a curator are automatically
 * funded by the treasury and transition to the `CuratorProposed` state. This
 * ensures that curator-assigned bounties receive funding and are ready for
 * curator acceptance without additional manual steps.
 *
 * The test achieves this by:
 * - Setting up the treasury spend period timing
 * - Having Alice propose a bounty
 * - Approving the bounty with a curator assignment
 * - Advancing blocks to trigger the spend period
 * - Verifying the status changes from `ApprovedWithCurator` to `CuratorProposed`
 * - Confirming appropriate events are emitted
 */
export async function bountyFundingForApprovedWithCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER // 10% fee
  const description = 'Test bounty for funding with curator'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyWithCuratorTx = client.api.tx.bounties.approveBountyWithCurator(
    bountyIndex,
    testAccounts.bob.address,
    curatorFee,
  )
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyWithCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // verify the bounty status is CuratorProposed
  const bountyStatusAfterFunding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterFunding.status.isCuratorProposed).toBe(true)

  await client.teardown()
}

/**
 * Test: Curator Assignment and Acceptance Workflow
 *
 * This test verifies the complete curator lifecycle from assignment to acceptance.
 * Curators are responsible for managing bounties and must deposit funds as collateral
 * to ensure they fulfill their responsibilities.
 *
 * The test achieves this by:
 * - Creating a funded bounty through the approval process
 * - Having the `Treasurer` propose Bob as curator
 * - Verifying the status changes from `Funded` to `CuratorProposed`
 * - Having Bob accept the curator role
 * - Confirming the status changes to `Active` and curator deposit is reserved
 * - Checking that appropriate events are emitted throughout the process
 */
export async function curatorAssignmentAndAcceptanceTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for funding'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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

  await client.teardown()
}

/**
 * Test: Bounty Expiry Extension
 *
 * This test verifies that curators can extend the expiry date of active bounties.
 * This functionality is crucial for allowing curators additional time to complete
 * their work or find suitable beneficiaries when needed.
 *
 * The test achieves this by:
 * - Creating an active bounty with a curator
 * - Having the curator extend the bounty expiry
 * - Verifying the `updateDue` date is extended
 * - Confirming the `BountyExtended` event is emitted
 * - Checking that the bounty remains in `Active` state
 */
export async function bountyExtensionTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for funding'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER

  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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

  await client.dev.newBlock()

  // log the bounty and get updateDue before extension
  const bountyForExtending = await getBounty(client, bountyIndex)

  // Get updateDue before extension
  const updateDueBefore = bountyForExtending.status.asActive.updateDue.toNumber()

  // extend the bounty expiry
  const extendBountyTx = client.api.tx.bounties.extendBountyExpiry(bountyIndex, 'Testing the bounty extension')
  const extendBountyEvents = await sendTransaction(extendBountyTx.signAsync(testAccounts.bob))

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
 * Test: Complete Bounty Awarding and Claiming Workflow
 *
 * This test verifies the end-to-end process of awarding a bounty to a beneficiary
 * and allowing them to claim the funds after the required delay period. This
 * ensures that completed work is properly rewarded while maintaining security
 * through the delay mechanism.
 *
 * The test achieves this by:
 * - Creating an active bounty with a curator
 * - Having the curator award the bounty to `Alice`
 * - Verifying the status changes to `PendingPayout`
 * - Advancing blocks to reach the claimable period
 * - Having Alice claim the bounty
 * - Confirming the bounty is removed from storage
 * - Checking that appropriate events are emitted throughout
 */
export async function bountyAwardingAndClaimingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for funding'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER

  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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

  await client.dev.newBlock()

  // award the bounty to the beneficiary
  const awardBountyTx = client.api.tx.bounties.awardBounty(bountyIndex, testAccounts.alice.address)
  const awardBountyEvents = await sendTransaction(awardBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify events
  await checkEvents(awardBountyEvents, { section: 'bounties', method: 'BountyAwarded' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty awarded events')

  // verify the bounty is awarded
  const bountyAwarded = await getBounty(client, bountyIndex)
  expect(bountyAwarded.status.isPendingPayout).toBe(true)

  // get the bounty deposit payout delay
  const bountyDepositPayoutDelay = await client.api.consts.bounties.bountyDepositPayoutDelay

  // wait for the unlock at block number
  await client.dev.newBlock({ blocks: bountyDepositPayoutDelay.toNumber() })

  await client.dev.newBlock()

  // claim the bounty
  const claimBountyTx = client.api.tx.bounties.claimBounty(bountyIndex)
  const claimBountyEvents = await sendTransaction(claimBountyTx.signAsync(testAccounts.alice))

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
 * Test: Bounty Closure in `Proposed` State
 *
 * This test verifies that treasury administrators can close bounties that are
 * still in the proposed state, rejecting them before they receive approval.
 * This is important for governance as it allows removal of inappropriate or
 * outdated bounty proposals while penalizing proposers for wasted resources.
 *
 * The test achieves this by:
 * - Having Alice propose a bounty
 * - Using the `Treasurer` origin to close the bounty
 * - Verifying the proposer's bond is slashed (not returned)
 * - Confirming the bounty is removed from storage
 * - Checking that `BountyRejected` and `Slashed` events are emitted
 */
export async function bountyClosureProposedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for closure in proposed state'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Verify bounty is in Proposed state
  const proposedBounty = await getBounty(client, bountyIndex)
  expect(proposedBounty.status.isProposed).toBe(true)

  // Close the bounty using Treasurer origin
  const closeBountyTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const finalBalance = await client.api.query.system.account(testAccounts.alice.address)
  const reservedBalance = finalBalance.data.reserved.toBigInt()

  // The bond should be slashed (not returned to free balance)
  expect(reservedBalance).toBe(0n) // Reserved should be 0 after slash

  await client.teardown()
}

/**
 * Test: Bounty Closure in `Funded` State
 *
 * This test verifies that treasury administrators can close bounties that have
 * been funded but not yet assigned to curators. This allows recovery of treasury
 * funds from bounties that are no longer needed or have become obsolete.
 *
 * The test achieves this by:
 * - Creating a funded bounty through the approval process
 * - Using the `Treasurer` origin to close the bounty
 * - Verifying the bounty funds are transferred back to treasury
 * - Confirming the bounty is removed from storage
 * - Checking that `BountyCanceled` and `Transfer` events are emitted
 */
export async function bountyClosureFundedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for closure in funded state'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  await client.dev.newBlock()
  // Bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // Verify bounty is funded
  const fundedBounty = await getBounty(client, bountyIndex)
  expect(fundedBounty.status.isFunded).toBe(true)

  // get treasury balance before closure
  const treasuryAccountId = client.api.consts.treasury.potAccount.toHex()
  const treasuryAccountBeforeClosureInfo = await client.api.query.system.account(treasuryAccountId)
  const treasuryBalanceBeforeClosure = treasuryAccountBeforeClosureInfo.data.free.toBigInt()

  // Close the bounty
  const closeBountyTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Verify BountyCanceled event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyCanceled' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty canceled events')

  // verify the transfer event
  await checkSystemEvents(client, { section: 'balances', method: 'Transfer' })
    .redact({ redactKeys: /from|to/ })
    .toMatchSnapshot('bounty value transferred to treasury')

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
 * Test: Bounty Closure in `Active` State
 *
 * This test verifies that treasury administrators can close bounties that are
 * currently active with assigned curators. This allows recovery of both treasury
 * funds and curator deposits when bounties need to be terminated.
 *
 * The test achieves this by:
 * - Creating an active bounty with an assigned curator
 * - Using the `Treasurer` origin to close the bounty
 * - Verifying the curator deposit is refunded
 * - Confirming the bounty funds are transferred back to treasury
 * - Checking that the bounty is removed from storage
 * - Validating that `BountyCanceled` and `Transfer` events are emitted
 */
export async function bountyClosureActiveTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for closure in active state'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyApproved' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty approved events')

  await client.dev.newBlock()
  // Bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  await client.dev.newBlock()

  // Propose a curator
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the CuratorProposed event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorProposed' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator proposed events')

  // Accept curator role
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // Verify bounty is in Active state
  const activeBounty = await getBounty(client, bountyIndex)
  expect(activeBounty.status.isActive).toBe(true)

  // Get curator reserved balance before closure
  const curatorBalanceBeforeClosure = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceBeforeClosure = curatorBalanceBeforeClosure.data.reserved.toBigInt()

  // Close the bounty
  const closeBountyTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const curatorBalanceAfterClosure = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceAfterClosure = curatorBalanceAfterClosure.data.reserved.toBigInt()
  expect(curatorReservedBalanceBeforeClosure).toBeGreaterThan(curatorReservedBalanceAfterClosure)

  await client.teardown()
}

/**
 * Test: Curator Unassignment in `ApprovedWithCurator` State
 *
 * This test verifies that treasury administrators can unassign curators from
 * bounties that are in the `ApprovedWithCurator` state. This provides flexibility
 * to change curator assignments before the bounty becomes active.
 *
 * The test achieves this by:
 * - Having Alice propose a bounty
 * - Approving the bounty with a curator assignment
 * - Using the `Treasurer` origin to unassign the curator
 * - Verifying the status changes back to `Approved`
 * - Confirming the `CuratorUnassigned` event is emitted
 */
export async function unassignCuratorApprovedWithCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator in approved with curator state'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve bounty with curator
  const approveBountyWithCuratorTx = client.api.tx.bounties.approveBountyWithCurator(
    bountyIndex,
    testAccounts.bob.address,
    curatorFee,
  )
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyWithCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Verify bounty is in ApprovedWithCurator state
  const approvedWithCuratorBounty = await getBounty(client, bountyIndex)
  expect(approvedWithCuratorBounty.status.isApprovedWithCurator).toBe(true)

  // Unassign curator using Treasurer
  const unassignCuratorTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    unassignCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
 * Test: Curator Unassignment in `CuratorProposed` State
 *
 * This test verifies that treasury administrators can unassign curators from
 * bounties that are in the `CuratorProposed` state. This allows changing curator
 * assignments even after the bounty has been funded but before the curator
 * has accepted their role.
 *
 * The test achieves this by:
 * - Creating a funded bounty with a proposed curator
 * - Using the `Treasurer` origin to unassign the curator
 * - Verifying the status changes to `Funded`
 * - Confirming the `CuratorUnassigned` event is emitted
 */
export async function unassignCuratorCuratorProposedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator in curator proposed state'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // verify status of the bounty
  const bountyStatusAfterProposal = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterProposal.status.isProposed).toBe(true)

  // Approve the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Verify bounty is in CuratorProposed state
  const curatorProposedBounty = await getBounty(client, bountyIndex)
  expect(curatorProposedBounty.status.isCuratorProposed).toBe(true)

  // Unassign curator using Treasurer
  const unassignCuratorTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    unassignCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
 * Test: Curator Self-Unassignment in `Active` State
 *
 * This test verifies that curators can voluntarily unassign themselves from
 * active bounties. This provides curators with an exit mechanism when they
 * cannot fulfill their responsibilities, with their deposit being refunded
 * since they initiated the unassignment.
 *
 * The test achieves this by:
 * - Creating an active bounty with Bob as curator
 * - Having Bob unassign himself from the bounty
 * - Verifying the status changes to `Funded`
 * - Confirming the curator deposit is refunded (not slashed)
 * - Checking that the `CuratorUnassigned` event is emitted
 */
export async function unassignCuratorActiveByCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator active by curator'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
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
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Get curator reserved balance before unassign
  const curatorBalanceBefore = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceBefore = curatorBalanceBefore.data.reserved.toBigInt()

  // Unassign curator by curator themselves
  const unassignCuratorTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned active by curator events')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)

  // Verify curator deposit was refunded as the caller is the curator so dont slash the curator
  const curatorBalanceAfter = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceAfter = curatorBalanceAfter.data.reserved.toBigInt()
  expect(curatorReservedBalanceAfter).toBeLessThan(curatorReservedBalanceBefore)

  await client.teardown()
}

/**
 * Test: Curator Unassignment by `Treasurer` in `Active` State
 *
 * This test verifies that treasury administrators can forcibly unassign curators
 * from active bounties. This is a disciplinary action where the curator's
 * deposit is slashed as a penalty for not fulfilling their responsibilities or acting maliciously.
 *
 * The test achieves this by:
 * - Creating an active bounty with Bob as curator
 * - Using the `Treasurer` origin to unassign Bob
 * - Verifying the status changes to `Funded`
 * - Confirming the curator deposit is slashed (not refunded)
 * - Checking that `CuratorUnassigned`, `Slashed`, and `Deposit` events are emitted
 */
export async function unassignCuratorActiveByTreasurerTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator active by treasurer'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
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
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Get curator balance before unassign
  const curatorBalanceBefore = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceBefore = curatorBalanceBefore.data.reserved.toBigInt()

  // Unassign curator by Treasurer
  const unassignCuratorTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    unassignCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const curatorBalanceAfter = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceAfter = curatorBalanceAfter.data.reserved.toBigInt()
  expect(curatorReservedBalanceBefore).toBeGreaterThan(curatorReservedBalanceAfter)

  await client.teardown()
}

/**
 * Test: Curator Unassignment in `PendingPayout` State
 *
 * This test verifies that treasury administrators can unassign curators from
 * bounties that are in the `PendingPayout` state. By doing so, they are claiming the curator is acting maliciously,
 * so we slash the curator.
 *
 * The test achieves this by:
 * - Creating a bounty that has been awarded (`PendingPayout` state)
 * - Using the `Treasurer` origin to unassign the curator
 * - Verifying the status changes to `Funded`
 * - Confirming the curator deposit is slashed
 * - Checking that appropriate events are emitted
 */
export async function unassignCuratorPendingPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator pending payout'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
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
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the CuratorAccepted event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorAccepted' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator accepted events')

  // verify the status is Active
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Award the bounty
  const awardBountyTx = client.api.tx.bounties.awardBounty(bountyIndex, testAccounts.alice.address)
  await sendTransaction(awardBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // verify the BountyAwarded event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyAwarded' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty awarded events')

  // verify the status is PendingPayout
  const bountyStatusAfterAwarding = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterAwarding.status.isPendingPayout).toBe(true)

  // Get curator reserved balance before unassign
  const curatorBalanceBefore = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceBefore = curatorBalanceBefore.data.reserved.toBigInt()

  // Unassign curator by Treasurer
  const unassignCuratorTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    unassignCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  const curatorBalanceAfter = await client.api.query.system.account(testAccounts.bob.address)
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty Closure Tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty closure in proposed state',
        testFn: async () => await bountyClosureProposedTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty closure in funded state',
        testFn: async () => await bountyClosureFundedTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty closure in active state',
        testFn: async () => await bountyClosureActiveTest(chain, testConfig),
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'All curator unassign tests',
    children: [
      {
        kind: 'test',
        label: 'Unassign curator in ApprovedWithCurator state',
        testFn: async () => await unassignCuratorApprovedWithCuratorTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Unassign curator in CuratorProposed state',
        testFn: async () => await unassignCuratorCuratorProposedTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Unassign curator in Active state by curator themselves',
        testFn: async () => await unassignCuratorActiveByCuratorTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Unassign curator in Active state by Treasurer',
        testFn: async () => await unassignCuratorActiveByTreasurerTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Unassign curator in PendingPayout state',
        testFn: async () => await unassignCuratorPendingPayoutTest(chain, testConfig),
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty approval tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty approval flow',
        testFn: async () => await bountyApprovalTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty approval flow with curator',
        testFn: async () => await bountyApprovalWithCuratorTest(chain, testConfig),
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty funding tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty funding for Approved Bounties',
        testFn: async () => await bountyFundingTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty funding for ApprovedWithCurator Bounties',
        testFn: async () => await bountyFundingForApprovedWithCuratorTest(chain, testConfig),
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
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
        testFn: async () => await curatorAssignmentAndAcceptanceTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty extension',
        testFn: async () => await bountyExtensionTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty awarding and claiming',
        testFn: async () => await bountyAwardingAndClaimingTest(chain, testConfig),
      },
      bountyFundingTests(chain, testConfig),
      bountyApprovalTests(chain, testConfig),
      bountyClosureTests(chain, testConfig),
      allCuratorUnassignTests(chain, testConfig),
    ],
  } as RootTestTree
}

/**
 * Test: Bounty Closure Failure in `Approved` State
 *
 * This test verifies that treasury(council) administrators cannot close bounties that are
 * in the `Approved` state. For weight reasons, we don't allow a council to cancel in this phase.
 *
 * The test achieves this by:
 * - Having Alice propose and get a bounty approved
 * - Attempting to close the bounty using the `Treasurer` (council) origin
 * - Verifying the transaction fails with `UnexpectedStatus` error
 * - Confirming the bounty remains in `Approved` state
 * - Checking that the error is properly reported through scheduler events
 */
export async function bountyClosureApprovedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for closure in approved state'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Verify bounty is in Approved state
  const approvedBounty = await getBounty(client, bountyIndex)
  expect(approvedBounty.status.isApproved).toBe(true)

  // Try to close the bounty - should fail
  const closeBountyTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('scheduler events when closing bounty with approved state fails')

  // check the result of dispatched event
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
  expect(bountyAfterFailedClosure).toBeTruthy()
  expect(bountyAfterFailedClosure.status.isApproved).toBe(true)

  await client.teardown()
}

/**
 * Test: Bounty Closure Failure in `PendingPayout` State
 *
 * This test verifies that treasury administrators cannot directly close bounties
 * that are in the `PendingPayout` state. If council wants to cancel
 * this bounty, it should mean the curator was acting maliciously.
 * So the council should first unassign the curator, slashing their
 * deposit.
 *
 * The test achieves this by:
 * - Creating a bounty that has been awarded (`PendingPayout` state)
 * - Attempting to close the bounty using the `Treasurer` origin
 * - Verifying the transaction fails with `PendingPayout` error
 * - Confirming the bounty remains in `PendingPayout` state
 * - Checking that the error is properly reported through scheduler events
 */
export async function bountyClosurePendingPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for closure in pending payout state'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // Approve the bounty
  const bountyIndex = await getBountyIndexFromEvent(client)
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  // Propose a curator
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Accept curator role
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Award the bounty
  const awardBountyTx = client.api.tx.bounties.awardBounty(bountyIndex, testAccounts.alice.address)
  await sendTransaction(awardBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Verify bounty is in PendingPayout state
  const pendingPayoutBounty = await getBounty(client, bountyIndex)
  expect(pendingPayoutBounty.status.isPendingPayout).toBe(true)

  // Try to close the bounty - should fail
  const closeBountyTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

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
  expect(bountyAfterFailedClosure).toBeTruthy()
  expect(bountyAfterFailedClosure.status.isPendingPayout).toBe(true)

  await client.teardown()
}

/**
 * Test: Premature Curator Unassignment by Public User
 *
 * This test verifies that public users cannot immediately unassign curators
 * from active bounties. There is a timing restriction to prevent malicious
 * actors from disrupting bounty operations. Users must wait for the proper
 * timing window before they can unassign curators.
 *
 * The test achieves this by:
 * - Creating an active bounty with an assigned curator
 * - Having Charlie (public user) attempt to unassign the curator immediately
 * - Verifying the transaction fails with `Premature` error
 * - Confirming the bounty remains in `Active` state
 * - Checking that the error is properly reported through `ExtrinsicFailed` event
 */
async function unassignCuratorActiveStateByPublicPrematureTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for premature unassign curator by public'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // Approve the bounty
  const bountyIndex = await getBountyIndexFromEvent(client)
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  // Propose Bob as curator
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Bob accepts curator role
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Verify bounty is in Active state
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isActive).toBe(true)

  // Charlie (public user) tries to unassign curator immediately (premature)
  // Using sendTransaction to simulate public call
  const unassignCuratorTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Check the result of dispatched event
  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.Premature.is(dispatchError.asModule)).toBeTruthy()

  // Verify bounty is still in storage and still Active
  const bountyAfterFailedUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterFailedUnassign).toBeTruthy()
  expect(bountyAfterFailedUnassign.status.isActive).toBe(true)

  await client.teardown()
}

/**
 * Test: Bounty Proposal with Oversized Description
 *
 * This test verifies that the system properly rejects bounty proposals with
 * descriptions that exceed the maximum allowed length. This prevents storage
 * bloat and ensures reasonable description sizes for governance efficiency.
 *
 * The test achieves this by:
 * - Having Alice attempt to propose a bounty with an oversized description
 * - Verifying the transaction fails with `ReasonTooBig` error
 * - Confirming the error is properly reported through `ExtrinsicFailed` event
 */
async function reasonTooBigTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const maxReasonLength = client.api.consts.bounties.maximumReasonLength.toNumber()

  // Create a description that exceeds the maximum length
  const longDescription = 'x'.repeat(maxReasonLength + 1)

  const proposeTx = client.api.tx.bounties.proposeBounty(bountyValue, longDescription)

  await sendTransaction(proposeTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.ReasonTooBig.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: Bounty Proposal with Insufficient Value
 *
 * This test verifies that the system properly rejects bounty proposals with
 * values below the minimum threshold. This ensures bounties have meaningful
 * value and prevents spam proposals with negligible amounts.
 *
 * The test achieves this by:
 * - Having Alice attempt to propose a bounty with value below the minimum
 * - Verifying the transaction fails with `InvalidValue` error
 * - Confirming the error is properly reported through `ExtrinsicFailed` event
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
  const invalidValue = bountyValueMinimum - 1n

  const proposeTx = client.api.tx.bounties.proposeBounty(invalidValue, description)

  await sendTransaction(proposeTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidValue.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: Approval of Non-Existent Bounty
 *
 * This test verifies that the system properly handles attempts to approve
 * bounties that do not exist. This prevents errors and ensures robust error
 * handling when invalid bounty indices are provided.
 *
 * The test achieves this by:
 * - Attempting to approve a bounty with a non-existent index
 * - Verifying the transaction fails with `InvalidIndex` error
 * - Confirming the error is properly reported through scheduler events
 */
async function invalidIndexApprovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const nonExistentBountyIndex = NON_EXISTENT_BOUNTY_INDEX // random index that doesn't exist

  await setupTestAccounts(client, ['alice'])

  // approve transaction with origin treasurer
  const approveBountyTx = client.api.tx.bounties.approveBounty(nonExistentBountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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
 * Test: Curator Proposal Before Bounty Funding
 *
 * This test verifies that curators cannot be proposed for bounties that
 * have not yet been funded. This ensures the proper sequence of operations:
 * bounty must be funded before curator assignment can occur.
 *
 * The test achieves this by:
 * - Having Alice propose a bounty
 * - Attempting to propose a curator before the bounty is funded
 * - Verifying the transaction fails with `UnexpectedStatus` error
 * - Confirming the error is properly reported through scheduler events
 */
async function unexpectedStatusProposeCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for curator proposal'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER

  // propose curator by Treasurer
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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
 * Test: Unauthorized Curator Acceptance
 *
 * This test verifies that only the designated curator can accept a curator
 * role for a bounty. This prevents unauthorized users from accepting
 * curator positions they were not assigned to.
 *
 * The test achieves this by:
 * - Creating a funded bounty with Bob proposed as curator
 * - Having Charlie attempt to accept the curator role
 * - Verifying the transaction fails with `RequireCurator` error
 * - Confirming the error is properly reported through `ExtrinsicFailed` event
 */
async function requireCuratorAcceptTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for curator requirement'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER

  // Propose Bob as curator
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Charlie tries to accept curator role (should be Bob)
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.RequireCurator.is(dispatchError.asModule)).toBeTruthy()

  await client.teardown()
}

/**
 * Test: Bounty Awarding with `Active` Child Bounties
 *
 * This test verifies that bounties with active child bounties cannot be
 * awarded. This prevents disruption of ongoing child bounty work and
 * ensures proper completion of all related child bounty activities.
 *
 * The test achieves this by:
 * - Creating an active bounty with a curator
 * - Having the curator create a child bounty
 * - Attempting to award the parent bounty
 * - Verifying the transaction fails with `HasActiveChildBounty` error
 * - Confirming the parent bounty remains in `Active` state
 */
async function hasActiveChildBountyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for child bounty check'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  // Approve the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  await client.dev.newBlock()
  // Bounty will be funded in this block
  await client.dev.newBlock()

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER

  // Propose Bob as curator
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // Bob accepts curator role
  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // Verify bounty is in Active state before creating child bounty
  const bountyStatusAfterCuratorAccepted = await getBounty(client, bountyIndex)
  expect(bountyStatusAfterCuratorAccepted.status.isActive).toBe(true)

  // Note: The curator (Bob) should create the child bounty, not Alice
  const childBountyValue = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER // value for child bounty
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

  // Verify parent bounty is still in Active state
  const parentBounty = await getBounty(client, bountyIndex)
  expect(parentBounty.status.isActive).toBe(true)

  // award the parent bounty
  const awardBountyTx = client.api.tx.bounties.awardBounty(bountyIndex, testAccounts.bob.address)
  await sendTransaction(awardBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.HasActiveChildBounty.is(dispatchError.asModule)).toBeTruthy()

  // Verify parent bounty is still in Active state
  const parentBountyAfterAward = await getBounty(client, bountyIndex)
  expect(parentBountyAfterAward.status.isActive).toBe(true)

  await client.teardown()
}

/**
 * Test: Premature Bounty Claiming in `Active` State
 *
 * This test verifies that beneficiaries cannot claim bounties that are
 * still in the `Active` state. Bounties must first be awarded by the curator
 * and reach the `PendingPayout` state before they can be claimed.
 *
 * The test achieves this by:
 * - Creating an active bounty with a curator
 * - Having `Alice` (beneficiary) attempt to claim the bounty while it's still active
 * - Verifying the transaction fails with `UnexpectedStatus` error
 * - Confirming the error is properly reported through `ExtrinsicFailed` event
 */
export async function bountyAwardingAndClaimingInActiveStateTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client, testConfig)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for funding'

  // propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

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
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  // verify the BountyApproved event
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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER

  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    testConfig.blockProvider,
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

  await client.dev.newBlock()

  // try to claim the bounty by beneficiary in active state
  const claimBountyTx = client.api.tx.bounties.claimBounty(bountyIndex)
  await sendTransaction(claimBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.UnexpectedStatus.is(dispatchError.asModule)).toBeTruthy()

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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'All bounty failure tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty closure in approved state',
        testFn: async () => await bountyClosureApprovedTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty closure in pending payout state',
        testFn: async () => await bountyClosurePendingPayoutTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Unassign curator in active state by public premature',
        testFn: async () => await unassignCuratorActiveStateByPublicPrematureTest(chain, testConfig),
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
        testFn: async () => await invalidIndexApprovalTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Unexpected status when proposing curator before bounty is funded',
        testFn: async () => await unexpectedStatusProposeCuratorTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Non-curator trying to accept curator role',
        testFn: async () => await requireCuratorAcceptTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty cannot be awarded if it has an active child bounty',
        testFn: async () => await hasActiveChildBountyTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'Bounty cannot be claimed in active state',
        testFn: async () => await bountyAwardingAndClaimingInActiveStateTest(chain, testConfig),
      },
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [allBountySuccessTests(chain, testConfig), allBountyFailureTests(chain, testConfig)],
  }
}
