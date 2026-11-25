import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client } from '@e2e-test/shared'

import { bnToU8a, compactAddLength, stringToU8a, u8aConcat } from '@polkadot/util'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect, type TestContext } from 'vitest'

import { match } from 'ts-pattern'
import {
  blockProviderOffset,
  checkEvents,
  checkSystemEvents,
  getBlockNumber,
  getFreeFunds,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// initial funding balance for accounts
const TEST_ACCOUNT_BALANCE_MULTIPLIER = 1_000_000n // 1_000_000x existential deposit (bounty deposit base is ~100_000x ED)

const NON_EXISTENT_BOUNTY_INDEX_OFFSET = 1000

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
async function setLastSpendPeriodBlockNumber(client: Client<any, any>) {
  const spendPeriod = client.api.consts.treasury.spendPeriod
  const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const offset = blockProviderOffset(
    client.config.properties.schedulerBlockProvider,
    (client.config.properties as any).relayBlocksPerParaBlock,
  )

  const newLastSpendPeriodBlockNumber = match(client.config.properties.schedulerBlockProvider)
    .with('Local', () => currentBlock - spendPeriod.toNumber() + TREASURY_SETUP_OFFSET * offset)
    .with('NonLocal', () => currentBlock - spendPeriod.toNumber() + TREASURY_SETUP_OFFSET * offset - offset)
    .exhaustive()
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

/** How far in the future, in block provider blocks, a vesting schedule starts so that none of it unlocks during a test. */
const VESTING_START_DELAY = 10_000_000

/**
 * Account holding a bounty's funds.
 *
 * Mirrors the runtime's derivation: the treasury's pallet id as a sub-account whose seed is the
 * SCALE-encoded tuple of the string `bt` and the bounty index, padded with zeroes to 32 bytes.
 */
function bountyAccount(client: Client<any, any>, bountyIndex: number): string {
  const palletId = client.api.consts.treasury.palletId.toU8a()
  const seed = u8aConcat(compactAddLength(stringToU8a('bt')), bnToU8a(bountyIndex, { bitLength: 32 }))
  const raw = u8aConcat(stringToU8a('modl'), palletId, seed, new Uint8Array(32)).slice(0, 32)
  return encodeAddress(raw, client.config.properties.addressEncoding)
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
>(client: Client<TCustom, TInitStorages>) {
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
>(client: Client<TCustom, TInitStorages>) {
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
}

/**
 * First runtime spec version of the Polkadot and Kusama Asset Hubs in which a bounty's payout is
 * sized from the balance its account can transfer.
 */
const SPENDABLE_PAYOUT_SPEC_VERSION = 2_006_000

/**
 * Run `body`, or skip the test when the runtime still sizes payouts from the whole free balance.
 */
function withSpendablePayouts(
  getClient: () => Client<any, any>,
  body: (client: Client<any, any>) => Promise<void>,
): (ctx?: TestContext) => Promise<void> {
  return async (ctx) => {
    const client = getClient()
    if (client.api.runtimeVersion.specVersion.toNumber() < SPENDABLE_PAYOUT_SPEC_VERSION) {
      ctx?.skip(`payouts from the spendable balance need spec version ${SPENDABLE_PAYOUT_SPEC_VERSION} or later`)
      return
    }
    await body(client)
  }
}

/**
 * Setup: a bounty in the `PendingPayout` state, built with real extrinsics.
 *
 * Alice proposes it, the `Treasurer` approves it, the treasury funds it at the end of its spend
 * period, the `Treasurer` proposes Bob as curator, Bob accepts and awards it to `beneficiary`.
 * Returns the bounty's index, its value and the curator's fee.
 */
async function createAwardedBounty(client: Client<any, any>, beneficiary: string) {
  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, 'Bounty awarded to a beneficiary')
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.approveBounty(bountyIndex).method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  expect(await getBountyApprovals(client)).toContain(bountyIndex)

  // The spend period ends in this block, and the treasury funds the approved bounty.
  await client.dev.newBlock()
  expect((await getBounty(client, bountyIndex)).status.isFunded).toBe(true)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee).method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  expect((await getBounty(client, bountyIndex)).status.isCuratorProposed).toBe(true)

  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(testAccounts.bob))
  await client.dev.newBlock()
  expect((await getBounty(client, bountyIndex)).status.isActive).toBe(true)

  await sendTransaction(client.api.tx.bounties.awardBounty(bountyIndex, beneficiary).signAsync(testAccounts.bob))
  await client.dev.newBlock()
  expect((await getBounty(client, bountyIndex)).status.isPendingPayout).toBe(true)

  return { bountyIndex, bountyValue, curatorFee }
}

/**
 * Test: `claim_bounty` pays out what the bounty's account can transfer and leaves locked funds behind.
 *
 * Anyone can lock funds in a bounty's account with a vested transfer. A payout sized from the whole
 * free balance would then ask for more than the account can move, and the beneficiary would get
 * nothing while the bounty is removed. The payout must be the spendable balance less the curator's
 * fee, so that the beneficiary is paid in full.
 *
 * 1. Alice proposes a bounty. It is approved and funded, Bob becomes its curator and awards it to Charlie.
 * 2. Alice makes a vested transfer to the bounty's account, with a schedule that has not started.
 * 3. Alice calls `claim_bounty`.
 * 4. `BountyClaimed` reports the bounty's value less the curator's fee as the payout.
 * 5. Charlie received exactly the payout, and Bob received his fee and his deposit back.
 * 6. The bounty is gone, and the locked amount is still in its account, still frozen.
 */
async function claimBountyWithLockedFundsTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const minVestedTransfer = client.api.consts.vesting.minVestedTransfer.toBigInt()
  const lockedAmount = (minVestedTransfer > existentialDeposit ? minVestedTransfer : existentialDeposit) * 10n

  // 1. Alice proposes a bounty. It is approved and funded, Bob becomes its curator and awards it to Charlie.
  const { bountyIndex, bountyValue, curatorFee } = await createAwardedBounty(client, testAccounts.charlie.address)
  const account = bountyAccount(client, bountyIndex)
  expect(await getFreeFunds(client, account)).toBe(bountyValue)

  // 2. Alice makes a vested transfer to the bounty's account, with a schedule that has not started.
  const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const vestedTransferTx = client.api.tx.vesting.vestedTransfer(account, {
    locked: lockedAmount,
    perBlock: lockedAmount,
    startingBlock: currentBlock + VESTING_START_DELAY,
  })
  await sendTransaction(vestedTransferTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  const accountBefore = await client.api.query.system.account(account)
  expect(accountBefore.data.free.toBigInt()).toBe(bountyValue + lockedAmount)
  expect(accountBefore.data.frozen.toBigInt()).toBe(lockedAmount)

  // The payout is already unlocked, so the claim below is not rejected as premature.
  const unlockAt = (await getBounty(client, bountyIndex)).status.asPendingPayout.unlockAt.toNumber()
  expect(unlockAt).toBeLessThanOrEqual(
    await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider),
  )

  const charlieBefore = await getFreeFunds(client, testAccounts.charlie.address)
  const bobBefore = await client.api.query.system.account(testAccounts.bob.address)

  // 3. Alice calls `claim_bounty`.
  const claimEvents = await sendTransaction(
    client.api.tx.bounties.claimBounty(bountyIndex).signAsync(testAccounts.alice),
  )
  await client.dev.newBlock()

  // 4. `BountyClaimed` reports the bounty's value less the curator's fee as the payout.
  await checkEvents(claimEvents, { section: 'bounties', method: 'BountyClaimed' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('bounty claimed events')

  const payout = bountyValue - curatorFee
  const records = await client.api.query.system.events()
  const claimed = records.filter(({ event }) => client.api.events.bounties.BountyClaimed.is(event))
  expect(claimed).toHaveLength(1)
  assert(client.api.events.bounties.BountyClaimed.is(claimed[0].event))
  expect(claimed[0].event.data.index.toNumber()).toBe(bountyIndex)
  expect(claimed[0].event.data.payout.toBigInt()).toBe(payout)
  expect(claimed[0].event.data.beneficiary.toString()).toBe(
    encodeAddress(testAccounts.charlie.address, client.config.properties.addressEncoding),
  )

  // 5. Charlie received exactly the payout, and Bob received his fee and his deposit back.
  expect((await getFreeFunds(client, testAccounts.charlie.address)) - charlieBefore).toBe(payout)
  const bobAfter = await client.api.query.system.account(testAccounts.bob.address)
  expect(bobAfter.data.reserved.toBigInt()).toBe(0n)
  expect(bobAfter.data.free.toBigInt()).toBe(
    bobBefore.data.free.toBigInt() + bobBefore.data.reserved.toBigInt() + curatorFee,
  )

  // 6. The bounty is gone, and the locked amount is still in its account, still frozen.
  expect(await getBounty(client, bountyIndex)).toBeNull()
  const accountAfter = await client.api.query.system.account(account)
  expect(accountAfter.data.free.toBigInt()).toBe(lockedAmount)
  expect(accountAfter.data.frozen.toBigInt()).toBe(lockedAmount)
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
>(client: Client<TCustom, TInitStorages>) {
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  // ------>

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
    client.config.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  // Verify BountyCanceled event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyCanceled' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty canceled events')

  // verify the transfer event
  const events = await client.api.query.system.events()
  const treasuryTransferEvent = events.find((record) => {
    const { event } = record
    if (event.section === 'balances' && event.method === 'Transfer') {
      assert(client.api.events.balances.Transfer.is(event))
      return (
        event.data.to.toString() ===
        encodeAddress(client.api.consts.treasury.potAccount.toHex(), client.config.properties.addressEncoding)
      )
    }
    return false
  })
  expect(treasuryTransferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(treasuryTransferEvent!.event))
  const treasuryTransferEventData = treasuryTransferEvent!.event.data
  expect(treasuryTransferEventData.amount.toBigInt()).toBe(bountyValue)

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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  // Verify BountyCanceled event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyCanceled' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty canceled event')

  // verify the curator transfer of balance event to the treasury
  const events = await client.api.query.system.events()
  const treasuryTransferEvent = events.find((record) => {
    const { event } = record
    if (event.section === 'balances' && event.method === 'Transfer') {
      assert(client.api.events.balances.Transfer.is(event))
      return (
        event.data.to.toString() ===
        encodeAddress(client.api.consts.treasury.potAccount.toHex(), client.config.properties.addressEncoding)
      )
    }
    return false
  })
  expect(treasuryTransferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(treasuryTransferEvent!.event))
  const treasuryTransferEventData = treasuryTransferEvent!.event.data
  // TODO: @dhirajs0, shouldn't this be unnecessary?
  expect(treasuryTransferEventData.amount.toBigInt()).toBe(curatorFee * 10n)

  // Verify bounty is removed from storage
  const bountyAfterClosure = await getBounty(client, bountyIndex)
  expect(bountyAfterClosure).toBeNull()

  // Verify curator deposit was refunded
  const curatorBalanceAfterClosure = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceAfterClosure = curatorBalanceAfterClosure.data.reserved.toBigInt()
  expect(curatorReservedBalanceBeforeClosure).toBeGreaterThan(curatorReservedBalanceAfterClosure)
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
>(client: Client<TCustom, TInitStorages>) {
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned approved with curator events')

  // Verify bounty status changed back to Approved
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isApproved).toBe(true)
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned curator proposed events')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator active by curator'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // verify the status is Proposed
  const bountyIndex = await getBountyIndexFromEvent(client)
  const bountyStatus = await getBounty(client, bountyIndex)
  expect(bountyStatus.status.isProposed).toBe(true)

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator active by treasurer'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const description = 'Test bounty for unassign curator pending payout'

  // Propose a bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const bountyProposedEvents = await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // verify the BountyProposed event
  await checkEvents(bountyProposedEvents, { section: 'bounties', method: 'BountyProposed' })
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty Closure Tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty closure in proposed state',
        testFn: async () => await bountyClosureProposedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty closure in funded state',
        testFn: async () => await bountyClosureFundedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty closure in active state',
        testFn: async () => await bountyClosureActiveTest(getClient()),
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
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All curator unassign tests',
    children: [
      {
        kind: 'test',
        label: 'Unassign curator in ApprovedWithCurator state',
        testFn: async () => await unassignCuratorApprovedWithCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Unassign curator in CuratorProposed state',
        testFn: async () => await unassignCuratorCuratorProposedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Unassign curator in Active state by curator themselves',
        testFn: async () => await unassignCuratorActiveByCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Unassign curator in Active state by Treasurer',
        testFn: async () => await unassignCuratorActiveByTreasurerTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Unassign curator in PendingPayout state',
        testFn: async () => await unassignCuratorPendingPayoutTest(getClient()),
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
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty approval tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty approval flow',
        testFn: async () => await bountyApprovalTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty approval flow with curator',
        testFn: async () => await bountyApprovalWithCuratorTest(getClient()),
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
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty funding tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty funding for Approved Bounties',
        testFn: async () => await bountyFundingTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty funding for ApprovedWithCurator Bounties',
        testFn: async () => await bountyFundingForApprovedWithCuratorTest(getClient()),
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
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All bounty success tests',
    children: [
      {
        kind: 'test',
        label: 'Creating a bounty',
        testFn: async () => await bountyCreationTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Curator assignment and acceptance',
        testFn: async () => await curatorAssignmentAndAcceptanceTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty extension',
        testFn: async () => await bountyExtensionTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty awarding and claiming',
        testFn: async () => await bountyAwardingAndClaimingTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty claim with locked funds in the bounty account',
        testFn: withSpendablePayouts(getClient, claimBountyWithLockedFundsTest),
      },
      bountyFundingTests(getClient),
      bountyApprovalTests(getClient),
      bountyClosureTests(getClient),
      allCuratorUnassignTests(getClient),
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
>(client: Client<TCustom, TInitStorages>) {
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
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
>(client: Client<TCustom, TInitStorages>) {
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
>(client: Client<TCustom, TInitStorages>) {
  const bountyCount = (await client.api.query.bounties.bountyCount()).toNumber()
  const nonExistentBountyIndex = bountyCount + NON_EXISTENT_BOUNTY_INDEX_OFFSET

  await setupTestAccounts(client, ['alice'])

  // approve transaction with origin treasurer
  const approveBountyTx = client.api.tx.bounties.approveBounty(nonExistentBountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveBountyTx.method.toHex(),
    {
      Origins: 'Treasurer',
    },
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

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
    client.config.properties.schedulerBlockProvider,
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
    client.config.properties.schedulerBlockProvider,
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
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All bounty failure tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty closure in approved state',
        testFn: async () => await bountyClosureApprovedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty closure in pending payout state',
        testFn: async () => await bountyClosurePendingPayoutTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Unassign curator in active state by public premature',
        testFn: async () => await unassignCuratorActiveStateByPublicPrematureTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Reason too big',
        testFn: async () => await reasonTooBigTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Invalid value',
        testFn: async () => await invalidValueTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Invalid bounty index approval',
        testFn: async () => await invalidIndexApprovalTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Unexpected status when proposing curator before bounty is funded',
        testFn: async () => await unexpectedStatusProposeCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Non-curator trying to accept curator role',
        testFn: async () => await requireCuratorAcceptTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty cannot be awarded if it has an active child bounty',
        testFn: async () => await hasActiveChildBountyTest(getClient()),
      },
      {
        kind: 'test',
        label: 'Bounty cannot be claimed in active state',
        testFn: async () => await bountyAwardingAndClaimingInActiveStateTest(getClient()),
      },
    ],
  } as RootTestTree
}

/// -------
/// Reclaiming funds from closed bounties
/// -------

/**
 * Id of USDT in the `Assets` pallet. The Polkadot and Kusama Asset Hub runtimes both list it among
 * the assets that are swept out of a bounty's account.
 */
const SWEPT_ASSET_ID = 1984

/**
 * Run `body`, or skip the test when the runtime has no `bounties.reclaim_bounty_funds` call.
 */
function withReclaimBountyFunds(
  getClient: () => Client<any, any>,
  body: (client: Client<any, any>) => Promise<void>,
): (ctx?: TestContext) => Promise<void> {
  return async (ctx) => {
    const client = getClient()
    if ((client.api.tx.bounties as any).reclaimBountyFunds === undefined) {
      ctx?.skip('bounties.reclaim_bounty_funds is not in this runtime')
      return
    }
    await body(client)
  }
}

/**
 * Build a `reclaim_bounty_funds` call. The API's static types come from a runtime without this
 * call, so it is reached untyped.
 */
function reclaimBountyFundsTx(client: Client<any, any>, bountyIndex: number) {
  return (client.api.tx.bounties as any).reclaimBountyFunds(bountyIndex)
}

/** The treasury pot, which receives everything reclaimed from a bounty's account. */
function treasuryPot(client: Client<any, any>): string {
  return encodeAddress(client.api.consts.treasury.potAccount.toHex(), client.config.properties.addressEncoding)
}

/** `who`'s balance of the asset `assetId` in the `Assets` pallet, zero when they hold none. */
async function assetBalance(client: Client<any, any>, assetId: number, who: string): Promise<bigint> {
  const account = await client.api.query.assets.account(assetId, who)
  return account.isSome ? account.unwrap().balance.toBigInt() : 0n
}

/**
 * Events of the `reclaim_bounty_funds` extrinsic in the head block.
 *
 * The extrinsic is located by its call, so the result holds for a call that emits no bounty event.
 */
async function reclaimExtrinsicEvents(client: Client<any, any>) {
  const { block } = await client.api.rpc.chain.getBlock()
  const index = block.extrinsics.findIndex(
    ({ method }) => method.section === 'bounties' && method.method === 'reclaimBountyFunds',
  )
  expect(index, 'the head block holds the reclaim extrinsic').toBeGreaterThanOrEqual(0)

  const records = await client.api.query.system.events()
  return records
    .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eqn(index))
    .map(({ event }) => event)
}

/**
 * Setup: a bounty that was proposed and then closed, so nothing is stored under its index any more.
 *
 * Alice proposes it and the `Treasurer` origin closes it while it is still `Proposed`. Its account
 * never received funds. Returns the bounty's index.
 */
async function createClosedBounty(client: Client<any, any>): Promise<number> {
  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, 'Bounty closed before funding')
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.bounties.closeBounty(bountyIndex).method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The scheduled close reports its outcome only through `Dispatched`.
  const dispatched = (await client.api.query.system.events()).find(({ event }) =>
    client.api.events.scheduler.Dispatched.is(event),
  )
  assert(dispatched && client.api.events.scheduler.Dispatched.is(dispatched.event))
  expect(dispatched.event.data.result.isOk).toBe(true)
  expect(await getBounty(client, bountyIndex)).toBeNull()

  return bountyIndex
}

/**
 * Test: funds sent to a closed bounty's account are reclaimed for the treasury, free of charge.
 *
 * Nothing in the bounty lifecycle touches a bounty's account once the bounty is gone, so tokens
 * that arrive later would stay there for good. `reclaim_bounty_funds` moves them to the treasury
 * pot. Anyone may call it, and a call that moves funds costs the caller nothing.
 *
 * 1. Alice proposes a bounty and the `Treasurer` closes it.
 * 2. Alice sends native tokens to the closed bounty's account.
 * 3. Charlie, who has no role in the bounty, calls `reclaim_bounty_funds`.
 * 4. The call emits `BountyFundsReclaimed` and moves the exact amount to the treasury pot.
 * 5. The bounty's account is empty, and Charlie's balance is unchanged.
 */
async function reclaimAfterClosureTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'charlie'])
  const strandedAmount = client.api.consts.balances.existentialDeposit.toBigInt() * 100n

  // 1. Alice proposes a bounty and the `Treasurer` closes it.
  const bountyIndex = await createClosedBounty(client)
  const account = bountyAccount(client, bountyIndex)
  expect(await getFreeFunds(client, account)).toBe(0n)

  // 2. Alice sends native tokens to the closed bounty's account.
  const strandTx = client.api.tx.balances.transferKeepAlive(account, strandedAmount)
  await sendTransaction(strandTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect(await getFreeFunds(client, account)).toBe(strandedAmount)

  const treasuryBefore = await getFreeFunds(client, treasuryPot(client))
  const charlieBefore = await getFreeFunds(client, testAccounts.charlie.address)

  // 3. Charlie, who has no role in the bounty, calls `reclaim_bounty_funds`.
  const reclaimEvents = await sendTransaction(reclaimBountyFundsTx(client, bountyIndex).signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 4. The call emits `BountyFundsReclaimed` and moves the exact amount to the treasury pot.
  await checkEvents(reclaimEvents, { section: 'bounties', method: 'BountyFundsReclaimed' })
    .redact({ redactKeys: /^bountyId$/ })
    .toMatchSnapshot('funds reclaimed events')

  const events = await reclaimExtrinsicEvents(client)
  const reclaimed = events.filter((event) => event.section === 'bounties' && event.method === 'BountyFundsReclaimed')
  expect(reclaimed).toHaveLength(1)
  expect((reclaimed[0].data as any).bountyId.toNumber()).toBe(bountyIndex)

  const transfers = events.filter((event) => client.api.events.balances.Transfer.is(event))
  expect(transfers).toHaveLength(1)
  assert(client.api.events.balances.Transfer.is(transfers[0]))
  expect(transfers[0].data.from.toString()).toBe(account)
  expect(transfers[0].data.to.toString()).toBe(treasuryPot(client))
  expect(transfers[0].data.amount.toBigInt()).toBe(strandedAmount)

  expect((await getFreeFunds(client, treasuryPot(client))) - treasuryBefore).toBe(strandedAmount)

  // 5. The bounty's account is empty, and Charlie's balance is unchanged.
  expect(await getFreeFunds(client, account)).toBe(0n)

  const success = events.find((event) => client.api.events.system.ExtrinsicSuccess.is(event))
  assert(success && client.api.events.system.ExtrinsicSuccess.is(success))
  expect(success.data.dispatchInfo.paysFee.isNo).toBe(true)
  expect(await getFreeFunds(client, testAccounts.charlie.address)).toBe(charlieBefore)
}

/**
 * Test: one `reclaim_bounty_funds` call sweeps a configured asset together with the native token.
 *
 * Which assets leave a bounty's account is decided by the runtime's `TransferAllAssets` setting,
 * which only a real runtime carries. USDT is on the list of both Asset Hubs.
 *
 * No test account can mint USDT, so Alice's holding is written to storage as a precondition, with
 * the asset's supply and account count raised to match. This is done before Alice sends anything,
 * because the write replaces her whole account record. Every transfer after that is a real
 * extrinsic.
 *
 * 1. Alice is given USDT.
 * 2. Alice proposes a bounty and the `Treasurer` closes it.
 * 3. Alice sends native tokens and USDT to the closed bounty's account.
 * 4. Charlie calls `reclaim_bounty_funds` once.
 * 5. Both the native tokens and the USDT arrive in the treasury pot, and the bounty's account holds neither.
 */
async function reclaimSweepsConfiguredAssetTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'charlie'])
  const nativeAmount = client.api.consts.balances.existentialDeposit.toBigInt() * 100n

  // 1. Alice is given USDT.
  const maybeAsset = await client.api.query.assets.asset(SWEPT_ASSET_ID)
  assert(maybeAsset.isSome, 'USDT exists on this chain')
  const asset = maybeAsset.unwrap()
  const assetAmount = asset.minBalance.toBigInt() * 100n
  const aliceAccount = await client.api.query.system.account(testAccounts.alice.address)
  await client.dev.setStorage({
    Assets: {
      asset: [
        [
          [SWEPT_ASSET_ID],
          {
            ...asset.toJSON(),
            supply: (asset.supply.toBigInt() + assetAmount).toString(),
            accounts: asset.accounts.toNumber() + 1,
          },
        ],
      ],
      account: [
        [[SWEPT_ASSET_ID, testAccounts.alice.address], { balance: assetAmount, status: 'Liquid', reason: 'Consumer' }],
      ],
    },
    // An asset account held for the reason `Consumer` keeps one consumer reference on its owner.
    System: {
      account: [
        [[testAccounts.alice.address], { ...aliceAccount.toJSON(), consumers: aliceAccount.consumers.toNumber() + 1 }],
      ],
    },
  })
  expect(await assetBalance(client, SWEPT_ASSET_ID, testAccounts.alice.address)).toBe(assetAmount)
  expect((await client.api.query.system.account(testAccounts.alice.address)).data.free.toBigInt()).toBe(
    aliceAccount.data.free.toBigInt(),
  )

  // 2. Alice proposes a bounty and the `Treasurer` closes it.
  const bountyIndex = await createClosedBounty(client)
  const account = bountyAccount(client, bountyIndex)

  // 3. Alice sends native tokens and USDT to the closed bounty's account.
  const strandNativeTx = client.api.tx.balances.transferKeepAlive(account, nativeAmount)
  await sendTransaction(strandNativeTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  const strandAssetTx = client.api.tx.assets.transfer(SWEPT_ASSET_ID, account, assetAmount)
  await sendTransaction(strandAssetTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect(await getFreeFunds(client, account)).toBe(nativeAmount)
  expect(await assetBalance(client, SWEPT_ASSET_ID, account)).toBe(assetAmount)

  const treasuryNativeBefore = await getFreeFunds(client, treasuryPot(client))
  const treasuryAssetBefore = await assetBalance(client, SWEPT_ASSET_ID, treasuryPot(client))

  // 4. Charlie calls `reclaim_bounty_funds` once.
  const reclaimEvents = await sendTransaction(reclaimBountyFundsTx(client, bountyIndex).signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  await checkEvents(reclaimEvents, { section: 'bounties', method: 'BountyFundsReclaimed' })
    .redact({ redactKeys: /^bountyId$/ })
    .toMatchSnapshot('funds reclaimed events')

  // 5. Both the native tokens and the USDT arrive in the treasury pot, and the bounty's account holds neither.
  const events = await reclaimExtrinsicEvents(client)
  const assetTransfers = events.filter((event) => client.api.events.assets.Transferred.is(event))
  expect(assetTransfers).toHaveLength(1)
  assert(client.api.events.assets.Transferred.is(assetTransfers[0]))
  expect(assetTransfers[0].data.assetId.toNumber()).toBe(SWEPT_ASSET_ID)
  expect(assetTransfers[0].data.from.toString()).toBe(account)
  expect(assetTransfers[0].data.to.toString()).toBe(treasuryPot(client))
  expect(assetTransfers[0].data.amount.toBigInt()).toBe(assetAmount)

  expect((await assetBalance(client, SWEPT_ASSET_ID, treasuryPot(client))) - treasuryAssetBefore).toBe(assetAmount)
  expect((await getFreeFunds(client, treasuryPot(client))) - treasuryNativeBefore).toBe(nativeAmount)
  expect(await assetBalance(client, SWEPT_ASSET_ID, account)).toBe(0n)
  expect(await getFreeFunds(client, account)).toBe(0n)
}

/**
 * Test: `reclaim_bounty_funds` takes only what can be transferred and leaves locked funds in place.
 *
 * Anyone can lock funds in a bounty's account with a vested transfer. The sweep must take the
 * liquid part and still succeed, without touching the locked part.
 *
 * 1. Alice proposes a bounty and the `Treasurer` closes it.
 * 2. Alice makes a vested transfer to the closed bounty's account, with a schedule that has not started.
 * 3. Alice also sends liquid native tokens to it.
 * 4. Charlie calls `reclaim_bounty_funds`.
 * 5. Only the liquid amount reaches the treasury pot, and the call is free.
 * 6. The locked amount is still in the bounty's account, still frozen.
 */
async function reclaimLeavesLockedFundsTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'charlie'])
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const minVestedTransfer = client.api.consts.vesting.minVestedTransfer.toBigInt()
  const lockedAmount = (minVestedTransfer > existentialDeposit ? minVestedTransfer : existentialDeposit) * 10n
  const liquidAmount = existentialDeposit * 100n

  // 1. Alice proposes a bounty and the `Treasurer` closes it.
  const bountyIndex = await createClosedBounty(client)
  const account = bountyAccount(client, bountyIndex)

  // 2. Alice makes a vested transfer to the closed bounty's account, with a schedule that has not started.
  const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const vestedTransferTx = client.api.tx.vesting.vestedTransfer(account, {
    locked: lockedAmount,
    perBlock: lockedAmount,
    startingBlock: currentBlock + VESTING_START_DELAY,
  })
  await sendTransaction(vestedTransferTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // 3. Alice also sends liquid native tokens to it.
  const strandTx = client.api.tx.balances.transferKeepAlive(account, liquidAmount)
  await sendTransaction(strandTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  const accountBefore = await client.api.query.system.account(account)
  expect(accountBefore.data.free.toBigInt()).toBe(lockedAmount + liquidAmount)
  expect(accountBefore.data.frozen.toBigInt()).toBe(lockedAmount)
  const treasuryBefore = await getFreeFunds(client, treasuryPot(client))

  // 4. Charlie calls `reclaim_bounty_funds`.
  const reclaimEvents = await sendTransaction(reclaimBountyFundsTx(client, bountyIndex).signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  await checkEvents(reclaimEvents, { section: 'bounties', method: 'BountyFundsReclaimed' })
    .redact({ redactKeys: /^bountyId$/ })
    .toMatchSnapshot('funds reclaimed events')

  // 5. Only the liquid amount reaches the treasury pot, and the call is free.
  const events = await reclaimExtrinsicEvents(client)
  const transfers = events.filter((event) => client.api.events.balances.Transfer.is(event))
  expect(transfers).toHaveLength(1)
  assert(client.api.events.balances.Transfer.is(transfers[0]))
  expect(transfers[0].data.from.toString()).toBe(account)
  expect(transfers[0].data.to.toString()).toBe(treasuryPot(client))
  expect(transfers[0].data.amount.toBigInt()).toBe(liquidAmount)
  expect((await getFreeFunds(client, treasuryPot(client))) - treasuryBefore).toBe(liquidAmount)

  const success = events.find((event) => client.api.events.system.ExtrinsicSuccess.is(event))
  assert(success && client.api.events.system.ExtrinsicSuccess.is(success))
  expect(success.data.dispatchInfo.paysFee.isNo).toBe(true)

  // 6. The locked amount is still in the bounty's account, still frozen.
  const accountAfter = await client.api.query.system.account(account)
  expect(accountAfter.data.free.toBigInt()).toBe(lockedAmount)
  expect(accountAfter.data.frozen.toBigInt()).toBe(lockedAmount)
}

/**
 * Test: `reclaim_bounty_funds` with nothing to move succeeds, emits no event, and charges the caller.
 *
 * A free call that does nothing could be repeated at no cost to fill blocks. The fee is waived only
 * when funds actually move.
 *
 * 1. Alice proposes a bounty and the `Treasurer` closes it. Its account stays empty.
 * 2. Charlie calls `reclaim_bounty_funds`.
 * 3. The extrinsic succeeds without any bounty event or transfer.
 * 4. Charlie paid the fee.
 */
async function reclaimNothingIsPaidTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'charlie'])

  // 1. Alice proposes a bounty and the `Treasurer` closes it. Its account stays empty.
  const bountyIndex = await createClosedBounty(client)
  const account = bountyAccount(client, bountyIndex)
  expect(await getFreeFunds(client, account)).toBe(0n)
  const charlieBefore = await getFreeFunds(client, testAccounts.charlie.address)

  // 2. Charlie calls `reclaim_bounty_funds`.
  await sendTransaction(reclaimBountyFundsTx(client, bountyIndex).signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 3. The extrinsic succeeds without any bounty event or transfer.
  const events = await reclaimExtrinsicEvents(client)
  const success = events.find((event) => client.api.events.system.ExtrinsicSuccess.is(event))
  assert(success && client.api.events.system.ExtrinsicSuccess.is(success))
  expect(events.filter((event) => event.section === 'bounties')).toHaveLength(0)
  expect(events.filter((event) => client.api.events.balances.Transfer.is(event))).toHaveLength(0)
  expect(await getFreeFunds(client, account)).toBe(0n)

  // 4. Charlie paid the fee.
  expect(success.data.dispatchInfo.paysFee.isYes).toBe(true)
  expect(await getFreeFunds(client, testAccounts.charlie.address)).toBeLessThan(charlieBefore)
}

/**
 * Test: `reclaim_bounty_funds` fails with `BountyStillActive` while the bounty exists.
 *
 * A bounty that is still stored manages its own account: its funds are owed to a beneficiary, a
 * curator or the treasury through the normal lifecycle. Sweeping it early would break that.
 *
 * 1. Alice proposes a bounty, which stays in the `Proposed` state.
 * 2. Alice sends native tokens to the bounty's account.
 * 3. Charlie calls `reclaim_bounty_funds`.
 * 4. The extrinsic fails with `BountyStillActive`.
 * 5. The bounty is still `Proposed` and its account still holds the tokens.
 */
async function reclaimWhileBountyExistsTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'charlie'])
  const strandedAmount = client.api.consts.balances.existentialDeposit.toBigInt() * 100n

  // 1. Alice proposes a bounty, which stays in the `Proposed` state.
  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, 'Bounty that is still proposed')
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  const bountyIndex = await getBountyIndexFromEvent(client)
  const account = bountyAccount(client, bountyIndex)

  // 2. Alice sends native tokens to the bounty's account.
  const strandTx = client.api.tx.balances.transferKeepAlive(account, strandedAmount)
  await sendTransaction(strandTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect((await getBounty(client, bountyIndex)).status.isProposed).toBe(true)
  expect(await getFreeFunds(client, account)).toBe(strandedAmount)

  // 3. Charlie calls `reclaim_bounty_funds`.
  const reclaimEvents = await sendTransaction(reclaimBountyFundsTx(client, bountyIndex).signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 4. The extrinsic fails with `BountyStillActive`.
  await checkEvents(reclaimEvents, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'reclaim failed events',
  )

  const events = await reclaimExtrinsicEvents(client)
  const failed = events.find((event) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(failed && client.api.events.system.ExtrinsicFailed.is(failed))
  const dispatchError = failed.data.dispatchError
  assert(dispatchError.isModule)
  const stillActive = (client.api.errors.bounties as any).BountyStillActive
  expect(stillActive, 'the runtime declares `BountyStillActive`').toBeDefined()
  expect(stillActive.is(dispatchError.asModule)).toBe(true)

  // 5. The bounty is still `Proposed` and its account still holds the tokens.
  expect((await getBounty(client, bountyIndex)).status.isProposed).toBe(true)
  expect(await getFreeFunds(client, account)).toBe(strandedAmount)
}

/**
 * Test: `reclaim_bounty_funds` rejects the `Root` origin.
 *
 * The call is open to every signed account and to nothing else. `Root` is not a signed origin, so
 * even the most privileged origin gets `BadOrigin`.
 *
 * 1. Alice proposes a bounty and the `Treasurer` closes it.
 * 2. Alice sends native tokens to the closed bounty's account.
 * 3. `reclaim_bounty_funds` is dispatched with the `Root` origin through the scheduler.
 * 4. The dispatch fails with `BadOrigin`.
 * 5. The tokens are still in the bounty's account.
 */
async function reclaimWithRootOriginTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])
  const strandedAmount = client.api.consts.balances.existentialDeposit.toBigInt() * 100n

  // 1. Alice proposes a bounty and the `Treasurer` closes it.
  const bountyIndex = await createClosedBounty(client)
  const account = bountyAccount(client, bountyIndex)

  // 2. Alice sends native tokens to the closed bounty's account.
  const strandTx = client.api.tx.balances.transferKeepAlive(account, strandedAmount)
  await sendTransaction(strandTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  expect(await getFreeFunds(client, account)).toBe(strandedAmount)

  // 3. `reclaim_bounty_funds` is dispatched with the `Root` origin through the scheduler.
  await scheduleInlineCallWithOrigin(
    client,
    reclaimBountyFundsTx(client, bountyIndex).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. The dispatch fails with `BadOrigin`.
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('scheduler events when Root reclaims')

  const records = await client.api.query.system.events()
  const dispatched = records.filter(({ event }) => client.api.events.scheduler.Dispatched.is(event))
  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  const result = dispatched[0].event.data.result
  assert(result.isErr)
  expect(result.asErr.isBadOrigin).toBe(true)
  expect(records.filter(({ event }) => event.section === 'bounties')).toHaveLength(0)

  // 5. The tokens are still in the bounty's account.
  expect(await getFreeFunds(client, account)).toBe(strandedAmount)
}

/**
 * Tests of `reclaim_bounty_funds`. Each one is skipped on a runtime without the call.
 */
export function reclaimBountyFundsTests(getClient: () => Client<any, any>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Reclaim bounty funds',
    children: [
      {
        kind: 'test',
        label: 'reclaim_bounty_funds - moves funds sent to a closed bounty to the treasury for free',
        testFn: withReclaimBountyFunds(getClient, reclaimAfterClosureTest),
      },
      {
        kind: 'test',
        label: 'reclaim_bounty_funds - sweeps a configured asset together with the native token',
        testFn: withReclaimBountyFunds(getClient, reclaimSweepsConfiguredAssetTest),
      },
      {
        kind: 'test',
        label: 'reclaim_bounty_funds - leaves locked funds in the account',
        testFn: withReclaimBountyFunds(getClient, reclaimLeavesLockedFundsTest),
      },
      {
        kind: 'test',
        label: 'reclaim_bounty_funds - charges the caller when nothing is moved',
        testFn: withReclaimBountyFunds(getClient, reclaimNothingIsPaidTest),
      },
      {
        kind: 'test',
        label: 'reclaim_bounty_funds - BountyStillActive while the bounty exists',
        testFn: withReclaimBountyFunds(getClient, reclaimWhileBountyExistsTest),
      },
      {
        kind: 'test',
        label: 'reclaim_bounty_funds - BadOrigin for Root',
        testFn: withReclaimBountyFunds(getClient, reclaimWithRootOriginTest),
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
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[client] = await createNetworks(chain)
      restoreSnapshot = captureSnapshot(client)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
      await client.dev.setHead(blockNumber)
    },
    afterAll: async () => {
      await client.api.disconnect().catch(() => {})
      await client.teardown().catch(() => {})
    },
    children: [
      allBountySuccessTests(() => client),
      allBountyFailureTests(() => client),
      reclaimBountyFundsTests(() => client),
    ],
  }
}
