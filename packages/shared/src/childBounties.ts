import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import { compactAddLength, stringToU8a, u8aConcat } from '@polkadot/util'
import type { HexString } from '@polkadot/util/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect, type TestContext } from 'vitest'

import { match } from 'ts-pattern'
import {
  blockProviderOffset,
  checkEvents,
  checkSystemEvents,
  getBlockNumber,
  getFreeFunds,
  scheduleInlineCallListWithSameOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// initial funding balance for accounts
const TEST_ACCOUNT_BALANCE_MULTIPLIER = 1_000_000n // 1_ 000_000x existential deposit

// 4 blocks before the spend period block
const TREASURY_SETUP_OFFSET = 4

// multipliers for the bounty and curator fee
// 1000x multiplier for substantial bounty value
const BOUNTY_MULTIPLIER = 1000n
// 10% curator fee (100/1000)
const CURATOR_FEE_MULTIPLIER = 100n

// 100x multiplier for substantial child bounty value
const CHILD_BOUNTY_MULTIPLIER = 100n
// 10% curator fee (10/100)
const CHILD_CURATOR_FEE_MULTIPLIER = 10n

/**
 * Configuration of the child bounties suite.
 */
export interface ChildBountiesTestConfig extends TestConfig {
  /**
   * Where the runtime sends a slashed child curator deposit.
   *
   * Child bounties slash through the `OnSlash` handler of the bounties pallet. That handler is runtime wiring,
   * which metadata does not expose, so each network file states it:
   *
   * - `'treasury'`: the treasury pot, which also emits `treasury.Deposit`.
   * - `'dapStaging'`: the staging account of the DAP pallet. The pallet moves the staging balance to its buffer
   *   account at the end of every block.
   */
  curatorSlashSink: 'treasury' | 'dapStaging'
}

/**
 * Build the address of the account a pallet owns: the type tag `modl`, the pallet id, then an optional
 * SCALE-encoded sub-account seed, cut or padded with zeros to 32 bytes.
 */
function palletAccount(client: Client<any, any>, palletId: Uint8Array, seed: Uint8Array = new Uint8Array()): string {
  const account = new Uint8Array(32)
  account.set(u8aConcat(stringToU8a('modl'), palletId, seed).slice(0, 32))
  return client.api.createType('AccountId32', account).toString()
}

/**
 * Account that holds the funds of a bounty: the sub-account of the treasury pallet id with the seed
 * `("bt", bounty index)`.
 */
function bountyAccount(client: Client<any, any>, bountyIndex: number) {
  const seed = client.api.createType('(Text, u32)', ['bt', bountyIndex]).toU8a()
  return palletAccount(client, client.api.consts.treasury.palletId.toU8a(), seed)
}

/**
 * Account that holds the funds of a child bounty: the sub-account of the treasury pallet id with the seed
 * `("cb", parent bounty index, child bounty index)`.
 */
function childBountyAccount(client: Client<any, any>, parentIndex: number, childIndex: number) {
  const seed = client.api.createType('(Text, u32, u32)', ['cb', parentIndex, childIndex]).toU8a()
  return palletAccount(client, client.api.consts.treasury.palletId.toU8a(), seed)
}

/**
 * Read the free balance of an account.
 */
async function getFreeBalance(client: Client<any, any>, who: string): Promise<bigint> {
  return (await client.api.query.system.account(who)).data.free.toBigInt()
}

/**
 * Account that receives slashed child curator deposits on this chain.
 *
 * Both sinks are pallet accounts. The treasury pot is the account of the treasury pallet id. The DAP staging
 * account is the sub-account of the DAP pallet id whose seed is the byte string `staging`.
 */
function curatorSlashSinkAccount(client: Client<any, any>, testConfig: ChildBountiesTestConfig) {
  return match(testConfig.curatorSlashSink)
    .with('treasury', () => palletAccount(client, client.api.consts.treasury.palletId.toU8a()))
    .with('dapStaging', () =>
      palletAccount(client, client.api.consts.dap.palletId.toU8a(), compactAddLength(stringToU8a('staging'))),
    )
    .exhaustive()
}

/**
 * Assert that the latest block slashed `deposit` from `curator`, once, and that the slashed funds reached the
 * chain's slash sink.
 *
 * A slash that reaches the sink is a `balances.Slashed` from the curator plus a `balances.Deposit` of the same
 * amount into the sink account. A treasury sink also emits `treasury.Deposit` with that value, and any other sink
 * leaves the treasury without a deposit. Transaction fees can land in the same sink as separate deposits, so the
 * sink deposit is matched by amount.
 */
async function expectCuratorSlashedToSink(
  client: Client<any, any>,
  testConfig: ChildBountiesTestConfig,
  curator: string,
  deposit: bigint,
) {
  const events = await client.api.query.system.events()

  const slashes = events.flatMap(({ event }) => (client.api.events.balances.Slashed.is(event) ? [event.data] : []))
  expect(slashes).toHaveLength(1)
  expect(slashes[0].who.eq(curator)).toBe(true)
  expect(slashes[0].amount.toBigInt()).toBe(deposit)

  const sink = curatorSlashSinkAccount(client, testConfig)
  const sinkDeposits = events.flatMap(({ event }) =>
    client.api.events.balances.Deposit.is(event) && event.data.who.eq(sink) ? [event.data.amount.toBigInt()] : [],
  )
  expect(sinkDeposits.filter((amount) => amount === deposit)).toHaveLength(1)

  const treasuryDeposits = events.flatMap(({ event }) =>
    client.api.events.treasury.Deposit.is(event) ? [event.data.value.toBigInt()] : [],
  )
  expect(treasuryDeposits).toEqual(testConfig.curatorSlashSink === 'treasury' ? [deposit] : [])
}

/**
 * Read the fee the given account paid for its extrinsic in the latest block.
 *
 * The fee leaves the signer's free balance in the same block as the call, so an exact check of a signer's balance
 * has to account for it.
 */
async function getFeePaidBy(client: Client<any, any>, who: string): Promise<bigint> {
  const events = await client.api.query.system.events()
  const fees = events.flatMap(({ event }) =>
    client.api.events.transactionPayment.TransactionFeePaid.is(event) && event.data.who.eq(who)
      ? [event.data.actualFee.toBigInt() + event.data.tip.toBigInt()]
      : [],
  )
  expect(fees).toHaveLength(1)
  return fees[0]
}

/**
 * Get a bounty by index
 */
async function getBounty(client: Client<any, any>, bountyIndex: number): Promise<any | null> {
  const bounty = await client.api.query.bounties.bounties(bountyIndex)
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
    eve: testAccounts.eve.address,
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

async function scheduleInlineCallWithOriginTreasurer(client: Client<any, any>, encodedCall: HexString) {
  await scheduleInlineCallWithOrigin(
    client,
    encodedCall,
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for child bounty creation'

  // ===== SECTION 1: Alice creates a parent bounty and it goes through the full lifecycle =====

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
  await scheduleInlineCallWithOriginTreasurer(client, approveBountyTx.method.toHex())

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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOriginTreasurer(client, proposeCuratorTx.method.toHex())

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

  // ===== SECTION 2: Bob (as parent curator) creates a child bounty =====

  const parentChildBountiesCountBefore = await getParentChildBountiesCount(client, bountyIndex)
  const parentTotalChildBountiesCountBefore = await getParentTotalChildBountiesCount(client, bountyIndex)
  const parentBountyBalanceBefore = await getFreeBalance(client, bountyAccount(client, bountyIndex))

  // Note: The curator (Bob) should create the child bounty, not Alice
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER // Smaller value for child bounty
  const childBountyDescription = 'Test child bounty'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 3: Verify proper events and storage =====

  // Check for ChildBountyAdded event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Added' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('child bounty added events')

  // the event names the parent bounty, and the next unused child index of that parent
  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)
  expect(parentIndex).toBe(bountyIndex)
  expect(childIndex).toBe(parentTotalChildBountiesCountBefore)

  // the child bounty value moved from the parent bounty account to the child bounty account
  expect(await getFreeBalance(client, bountyAccount(client, bountyIndex))).toBe(
    parentBountyBalanceBefore - childBountyValue,
  )
  expect(await getFreeBalance(client, childBountyAccount(client, bountyIndex, childIndex))).toBe(childBountyValue)

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
  expect(childBounty.value.toBigInt()).toBe(childBountyValue)
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for assigning and accepting a child bounty curator'

  // ===== SECTION 1: Create parent bounty and make it active with Bob as curator =====

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
  await scheduleInlineCallWithOriginTreasurer(client, approveBountyTx.method.toHex())

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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOriginTreasurer(client, proposeCuratorTx.method.toHex())

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

  // ===== SECTION 2: Bob creates a child bounty from the parent bounty =====

  // Create child bounty
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
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
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('child bounty added events')

  // Get child bounty indices
  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)
  expect(parentIndex).toBe(bountyIndex)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // ===== SECTION 3: Bob proposes Charlie as curator for the child bounty =====

  // Propose curator for child bounty
  const childCuratorFee = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
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

  // ===== SECTION 4: Charlie accepts the curator role, transitioning child bounty to Active status =====

  // Charlie has nothing reserved before accepting
  const charlieBeforeAccept = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieBeforeAccept.data.reserved.toBigInt()).toBe(0n)

  // Accept child bounty curator
  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty status is Active, curated by Charlie
  const childBountyAfterCuratorAccepted = await getChildBounty(client, parentIndex, childIndex)
  assert(childBountyAfterCuratorAccepted.status.isActive)
  expect(childBountyAfterCuratorAccepted.status.asActive.curator.eq(testAccounts.charlie.address)).toBe(true)

  // the curator deposit is the fee times `CuratorDepositMultiplier`, a parts-per-million ratio, kept within
  // `CuratorDepositMin` and `CuratorDepositMax` where the runtime sets them
  const { curatorDepositMultiplier, curatorDepositMin, curatorDepositMax } = client.api.consts.bounties
  let expectedCuratorDeposit = (childCuratorFee * curatorDepositMultiplier.toBigInt()) / 1_000_000n
  if (curatorDepositMax.isSome && expectedCuratorDeposit > curatorDepositMax.unwrap().toBigInt()) {
    expectedCuratorDeposit = curatorDepositMax.unwrap().toBigInt()
  }
  if (curatorDepositMin.isSome && expectedCuratorDeposit < curatorDepositMin.unwrap().toBigInt()) {
    expectedCuratorDeposit = curatorDepositMin.unwrap().toBigInt()
  }
  expect(childBountyAfterCuratorAccepted.curatorDeposit.toBigInt()).toBe(expectedCuratorDeposit)

  // accepting reserved exactly that deposit from Charlie
  const charlieAfterAccept = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfterAccept.data.reserved.toBigInt()).toBe(expectedCuratorDeposit)
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create parent bounty and make it active with Bob as curator =====

  const description = 'Test bounty for awarding and claiming a child bounty'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // ===== SECTION 2: Bob creates child bounty and assigns Charlie as child curator =====

  // Create child bounty
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for awarding'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // Assign and accept curator for child bounty
  const childCuratorFee = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
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

  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty is active
  const activeChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(activeChildBounty.status.isActive).toBe(true)

  // ===== SECTION 3: Charlie awards the child bounty to Dave (beneficiary) =====

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
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('child bounty awarded events')

  // the event names the child bounty and Dave as beneficiary
  const awardedEvents = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Awarded.is(event) ? [event.data] : [],
  )
  expect(awardedEvents).toHaveLength(1)
  expect(awardedEvents[0].index.toNumber()).toBe(parentIndex)
  expect(awardedEvents[0].childIndex.toNumber()).toBe(childIndex)
  expect(awardedEvents[0].beneficiary.eq(testAccounts.dave.address)).toBe(true)

  // Verify child bounty status is PendingPayout, for Dave, awarded by Charlie
  const awardedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  assert(awardedChildBounty.status.isPendingPayout)
  expect(awardedChildBounty.status.asPendingPayout.curator.eq(testAccounts.charlie.address)).toBe(true)
  expect(awardedChildBounty.status.asPendingPayout.beneficiary.eq(testAccounts.dave.address)).toBe(true)

  // ===== SECTION 4: Wait for payout delay period and Dave claims the bounty =====

  // Get payout delay from constants
  const payoutDelay = await client.api.consts.bounties.bountyDepositPayoutDelay

  // Fast forward to after payout delay
  await client.dev.newBlock({ count: payoutDelay.toNumber() + 1 })

  // balances before the claim: the child bounty account holds the whole value, and Charlie's only reserved funds
  // are the curator deposit
  const curatorDeposit = awardedChildBounty.curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  const childAccount = childBountyAccount(client, parentIndex, childIndex)
  expect(await getFreeBalance(client, childAccount)).toBe(childBountyValue)
  const daveFreeBalanceBefore = await getFreeBalance(client, testAccounts.dave.address)
  const charlieBeforeClaim = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieBeforeClaim.data.reserved.toBigInt()).toBe(curatorDeposit)

  // Claim the child bounty
  const claimChildBountyTx = client.api.tx.childBounties.claimChildBounty(parentIndex, childIndex)
  await sendTransaction(claimChildBountyTx.signAsync(testAccounts.dave))

  await client.dev.newBlock()

  // ===== SECTION 5: Verify proper events and storage cleanup =====

  // Check for ChildBountyClaimed event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Claimed' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('child bounty claimed events')

  // the payout is the child bounty value minus the curator fee, and it goes to Dave
  const expectedPayout = childBountyValue - childCuratorFee
  const claimedEvents = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Claimed.is(event) ? [event.data] : [],
  )
  expect(claimedEvents).toHaveLength(1)
  expect(claimedEvents[0].index.toNumber()).toBe(parentIndex)
  expect(claimedEvents[0].childIndex.toNumber()).toBe(childIndex)
  expect(claimedEvents[0].payout.toBigInt()).toBe(expectedPayout)
  expect(claimedEvents[0].beneficiary.eq(testAccounts.dave.address)).toBe(true)

  // Dave received the payout, and paid the fee of the claim call
  const claimFee = await getFeePaidBy(client, testAccounts.dave.address)
  expect(await getFreeBalance(client, testAccounts.dave.address)).toBe(
    daveFreeBalanceBefore + expectedPayout - claimFee,
  )

  // Charlie received the curator fee, and the curator deposit moved from reserved back to free
  const charlieAfterClaim = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfterClaim.data.reserved.toBigInt()).toBe(0n)
  expect(charlieAfterClaim.data.free.toBigInt()).toBe(
    charlieBeforeClaim.data.free.toBigInt() + curatorDeposit + childCuratorFee,
  )

  // the child bounty account paid everything out
  expect(await getFreeBalance(client, childAccount)).toBe(0n)

  // Verify child bounty is removed from storage, and no longer counted as active
  const claimedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(claimedChildBounty).toBeNull()
  expect(await getParentChildBountiesCount(client, parentIndex)).toBe(0)
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create parent bounty and make it active with Bob as curator =====

  const description = 'Test bounty for child bounty closure'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // ===== SECTION 2: Bob creates child bounty and assigns Charlie as child curator =====

  // Create child bounty
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for closure'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // Assign and accept curator for child bounty
  const childCuratorFee = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
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

  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty is active
  const activeChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(activeChildBounty.status.isActive).toBe(true)

  // ===== SECTION 3: Bob closes the child bounty before it's awarded =====

  // balances before the close: the child bounty account holds the whole value, and Charlie's only reserved funds
  // are the curator deposit
  const curatorDeposit = activeChildBounty.curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  const parentAccount = bountyAccount(client, parentIndex)
  const childAccount = childBountyAccount(client, parentIndex, childIndex)
  const parentBountyBalanceBefore = await getFreeBalance(client, parentAccount)
  expect(await getFreeBalance(client, childAccount)).toBe(childBountyValue)
  const charlieBeforeClose = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieBeforeClose.data.reserved.toBigInt()).toBe(curatorDeposit)

  // Close child bounty (by parent curator)
  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex)
  await sendTransaction(closeChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 4: Verify funds are returned to parent bounty account and storage is cleaned up =====

  // Check for ChildBountyCanceled event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Canceled' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('child bounty canceled events')

  // the event names the closed child bounty
  const canceledEvents = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Canceled.is(event) ? [event.data] : [],
  )
  expect(canceledEvents).toHaveLength(1)
  expect(canceledEvents[0].index.toNumber()).toBe(parentIndex)
  expect(canceledEvents[0].childIndex.toNumber()).toBe(childIndex)

  // verify that the balances pallet transferred the whole value from the child bounty account to the parent
  // bounty account
  const valueTransfers = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.balances.Transfer.is(event) && event.data.from.eq(childAccount) ? [event.data] : [],
  )
  expect(valueTransfers).toHaveLength(1)
  expect(valueTransfers[0].to.eq(parentAccount)).toBe(true)
  expect(valueTransfers[0].amount.toBigInt()).toBe(childBountyValue)
  expect(await getFreeBalance(client, parentAccount)).toBe(parentBountyBalanceBefore + childBountyValue)
  expect(await getFreeBalance(client, childAccount)).toBe(0n)

  // Charlie's curator deposit moved from reserved back to free; Bob paid the fee of the close call
  const charlieAfterClose = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfterClose.data.reserved.toBigInt()).toBe(0n)
  expect(charlieAfterClose.data.free.toBigInt()).toBe(charlieBeforeClose.data.free.toBigInt() + curatorDeposit)

  // Verify child bounty is removed from storage
  const closedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(closedChildBounty).toBeNull()

  // Verify child bounty description is removed
  const childBountyDesc = await getChildBountyDescription(client, parentIndex, childIndex)
  expect(childBountyDesc).toBeNull()

  // Verify child bounties count decreased
  const childBountiesCount = await getParentChildBountiesCount(client, parentIndex)
  expect(childBountiesCount).toBe(0)
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create parent bounty and make it active with Bob as curator =====

  const description = 'Test bounty for child bounty rejection and cancellation'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // ===== SECTION 2: Bob creates child bounty and proposes Charlie as curator =====

  // Create child bounty
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for rejection'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // Propose curator for child bounty
  const childCuratorFee = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
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

  // ===== SECTION 3: Charlie rejects the assignment (unassigns himself) =====

  // Test 1: Curator rejects the assignment (unassigns themselves)
  const unassignCuratorTx = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // Verify child bounty status is back to Added
  const rejectedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(rejectedChildBounty.status.isAdded).toBe(true)

  // ===== SECTION 4: Bob proposes Charlie again, then cancels the child bounty =====

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

  const parentBountyBalanceBefore = await getFreeBalance(client, bountyAccount(client, parentIndex))

  // Cancel child bounty by parent curator
  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex)
  await sendTransaction(closeChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 5: Verify proper events and storage cleanup in both cases =====

  // Check for ChildBountyCanceled event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Canceled' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('child bounty canceled events')

  // the event names the closed child bounty
  const canceledEvents = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Canceled.is(event) ? [event.data] : [],
  )
  expect(canceledEvents).toHaveLength(1)
  expect(canceledEvents[0].index.toNumber()).toBe(parentIndex)
  expect(canceledEvents[0].childIndex.toNumber()).toBe(childIndex)

  // the child bounty value is back in the parent bounty account
  expect(await getFreeBalance(client, bountyAccount(client, parentIndex))).toBe(
    parentBountyBalanceBefore + childBountyValue,
  )

  // Verify child bounty is removed from storage
  const canceledChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(canceledChildBounty).toBeNull()

  // Verify child bounty description is removed
  const childBountyDesc = await getChildBountyDescription(client, parentIndex, childIndex)
  expect(childBountyDesc).toBeNull()

  // Verify child bounties count is 0
  const childBountiesCount = await getParentChildBountiesCount(client, parentIndex)
  expect(childBountiesCount).toBe(0)
}

/**
 * Helper function to create and activate a parent bounty with curator
 */
async function createActiveParentBountyWithCurator<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, description: string, parentCuratorKeypair: KeyringPair) {
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER

  // Create parent bounty
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // Verify bounty is in Proposed state
  const proposedBounty = await getBounty(client, bountyIndex)
  expect(proposedBounty.status.isProposed).toBe(true)

  // Approve and fund the bounty
  const approveBountyTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOriginTreasurer(client, approveBountyTx.method.toHex())

  await client.dev.newBlock()

  // Verify the state is Approved
  const approvedBounty = await getBounty(client, bountyIndex)
  expect(approvedBounty.status.isApproved).toBe(true)

  await client.dev.newBlock({ count: 3 })

  // verify bounty is in Funded state
  const fundedBounty = await getBounty(client, bountyIndex)
  expect(fundedBounty.status.isFunded).toBe(true)

  // Assign and accept curator for parent bounty
  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, parentCuratorKeypair.address, curatorFee)
  await scheduleInlineCallWithOriginTreasurer(client, proposeCuratorTx.method.toHex())

  await client.dev.newBlock()

  // verify bounty is in CuratorProposed state
  const curatorProposedBounty = await getBounty(client, bountyIndex)
  expect(curatorProposedBounty.status.isCuratorProposed).toBe(true)

  const acceptCuratorTx = client.api.tx.bounties.acceptCurator(bountyIndex)
  await sendTransaction(acceptCuratorTx.signAsync(parentCuratorKeypair))

  await client.dev.newBlock()

  // verify bounty is in Active state
  const activeBounty = await getBounty(client, bountyIndex)
  expect(activeBounty.status.isActive).toBe(true)

  return bountyIndex
}

/**
 * Helper function to create and activate a child bounty with curator
 */
async function createActiveChildBountyWithCurator<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  client: Client<TCustom, TInitStorages>,
  parentBountyIndex: number,
  parentCuratorKeypair: KeyringPair,
  description: string,
  childCuratorKeypair: KeyringPair,
) {
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER

  // Create child bounty
  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(parentBountyIndex, childBountyValue, description)
  await sendTransaction(addChildBountyTx.signAsync(parentCuratorKeypair))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // Assign and accept curator for child bounty
  const childCuratorFee = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    childCuratorKeypair.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(parentCuratorKeypair))

  await client.dev.newBlock()

  // Verify child bounty status is CuratorProposed
  const childBountyAfterCuratorProposed = await getChildBounty(client, parentIndex, childIndex)
  expect(childBountyAfterCuratorProposed.status.isCuratorProposed).toBe(true)

  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptChildCuratorTx.signAsync(childCuratorKeypair))

  await client.dev.newBlock()

  // Verify child bounty is active
  const activeChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(activeChildBounty.status.isActive).toBe(true)

  return { parentIndex, childIndex }
}

/**
 * Child bounties under one parent bounty, one per status. Built by `createChildBountiesInEveryStatus`.
 */
interface ChildBountiesInEveryStatus {
  /** Index of the active parent bounty, curated by Bob. */
  parentIndex: number
  /** Child bounty left in `Added`: it has no curator. */
  added: number
  /** Child bounty in `CuratorProposed`: Charlie is proposed and has not accepted. */
  curatorProposed: number
  /** Child bounty in `Active`: Charlie is the curator and holds a deposit. */
  active: number
  /** Child bounty in `PendingPayout`: Charlie awarded it to Dave and still holds a deposit. */
  pendingPayout: number
  /** Value of each child bounty. */
  childValue: bigint
  /** Curator fee of each child bounty that has, or had, a curator proposed. */
  childFee: bigint
  /** Deposit Charlie reserved for each of the `Active` and `PendingPayout` child bounties. */
  curatorDeposit: bigint
}

/**
 * Build an active parent bounty curated by Bob, with four child bounties that between them cover every status a
 * child bounty can be in. Charlie is the curator of the three that have one, and Dave is the beneficiary of the
 * awarded one. Alice, Bob, Charlie, Dave and Eve are funded.
 *
 * Every step is a real extrinsic, and the resulting statuses are asserted before returning, so a caller can rely
 * on them as preconditions. Calls by the same signer are batched to keep the number of blocks low.
 */
async function createChildBountiesInEveryStatus<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>): Promise<ChildBountiesInEveryStatus> {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave', 'eve'])
  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  const parentIndex = await createActiveParentBountyWithCurator(
    client,
    'Parent of one child bounty per status',
    testAccounts.bob,
  )

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const childValue = bountyValueMinimum * CHILD_BOUNTY_MULTIPLIER
  const childFee = bountyValueMinimum * CHILD_CURATOR_FEE_MULTIPLIER

  // Bob adds the four child bounties
  const addTx = client.api.tx.utility.batchAll(
    ['Added', 'CuratorProposed', 'Active', 'PendingPayout'].map((status) =>
      client.api.tx.childBounties.addChildBounty(parentIndex, childValue, `Child bounty to reach ${status}`),
    ),
  )
  await sendTransaction(addTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  const childIndices = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Added.is(event) ? [event.data.childIndex.toNumber()] : [],
  )
  expect(childIndices).toHaveLength(4)
  const [added, curatorProposed, active, pendingPayout] = childIndices

  // Bob proposes Charlie as curator of three of them
  const proposeTx = client.api.tx.utility.batchAll(
    [curatorProposed, active, pendingPayout].map((childIndex) =>
      client.api.tx.childBounties.proposeCurator(parentIndex, childIndex, testAccounts.charlie.address, childFee),
    ),
  )
  await sendTransaction(proposeTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // Charlie accepts two of them
  const acceptTx = client.api.tx.utility.batchAll(
    [active, pendingPayout].map((childIndex) => client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)),
  )
  await sendTransaction(acceptTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // Charlie awards one of them to Dave
  const awardTx = client.api.tx.childBounties.awardChildBounty(parentIndex, pendingPayout, testAccounts.dave.address)
  await sendTransaction(awardTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // Each child bounty is in the status its name says
  const addedChild = await getChildBounty(client, parentIndex, added)
  expect(addedChild.status.isAdded).toBe(true)

  const curatorProposedChild = await getChildBounty(client, parentIndex, curatorProposed)
  assert(curatorProposedChild.status.isCuratorProposed)
  expect(curatorProposedChild.status.asCuratorProposed.curator.eq(testAccounts.charlie.address)).toBe(true)

  const activeChild = await getChildBounty(client, parentIndex, active)
  assert(activeChild.status.isActive)
  expect(activeChild.status.asActive.curator.eq(testAccounts.charlie.address)).toBe(true)

  const pendingPayoutChild = await getChildBounty(client, parentIndex, pendingPayout)
  assert(pendingPayoutChild.status.isPendingPayout)
  expect(pendingPayoutChild.status.asPendingPayout.curator.eq(testAccounts.charlie.address)).toBe(true)
  expect(pendingPayoutChild.status.asPendingPayout.beneficiary.eq(testAccounts.dave.address)).toBe(true)

  // Charlie holds one deposit for each of the two child bounties accepted, and nothing else in reserve
  const curatorDeposit = activeChild.curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  expect(pendingPayoutChild.curatorDeposit.toBigInt()).toBe(curatorDeposit)
  const charlieAccount = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAccount.data.reserved.toBigInt()).toBe(2n * curatorDeposit)

  return { parentIndex, added, curatorProposed, active, pendingPayout, childValue, childFee, curatorDeposit }
}

/**
 * Read everything a child-bounty call can change under one parent bounty: each child bounty and its description,
 * the active and total counters, the cumulative child curator fees, the free balances of the parent bounty account
 * and of the account of every child index the parent has handed out, and the reserved balance of the child curator.
 *
 * Failure tests read this before and after a rejected call and compare the two, to prove the call changed nothing.
 * Bounty and child bounty accounts never pay transaction fees, so their balances must match exactly. The account
 * of the next child index is included too, since a wrongly accepted add would fund it.
 */
async function getChildBountiesState(client: Client<any, any>, parentIndex: number, childCurator: string) {
  const entries = await client.api.query.childBounties.childBounties.entries(parentIndex)
  const descriptions = await client.api.query.childBounties.childBountyDescriptionsV1.entries(parentIndex)
  const totalCount = await getParentTotalChildBountiesCount(client, parentIndex)
  const childAccountBalances: Record<number, bigint> = {}
  for (let childIndex = 0; childIndex <= totalCount; childIndex++) {
    childAccountBalances[childIndex] = await getFreeBalance(client, childBountyAccount(client, parentIndex, childIndex))
  }
  const curatorAccount = await client.api.query.system.account(childCurator)
  return {
    childBounties: Object.fromEntries(
      entries.map(([key, childBounty]) => [key.args[1].toNumber(), childBounty.toJSON()]),
    ),
    descriptions: Object.fromEntries(
      descriptions.map(([key, description]) => [key.args[1].toNumber(), description.toHex()]),
    ),
    activeCount: await getParentChildBountiesCount(client, parentIndex),
    totalCount,
    childrenCuratorFees: (await client.api.query.childBounties.childrenCuratorFees(parentIndex)).toBigInt(),
    parentAccountBalance: await getFreeBalance(client, bountyAccount(client, parentIndex)),
    childAccountBalances,
    curatorReserved: curatorAccount.data.reserved.toBigInt(),
  }
}

/**
 * Read the dispatch error of every `utility.ItemFailed` event in the latest block, in emission order.
 *
 * `utility.forceBatch` emits one `ItemFailed` for each call that fails, as it goes through the calls, and the event
 * carries no call index. When every call of a batch fails, the n-th error in this list belongs to the n-th call.
 */
async function getItemFailedErrors(client: Client<any, any>) {
  const events = await client.api.query.system.events()
  return events.flatMap(({ event }) => (client.api.events.utility.ItemFailed.is(event) ? [event.data.error] : []))
}

/**
 * Read the data of every `scheduler.Dispatched` event in the latest block.
 *
 * A call injected into the scheduler's agenda never emits `ExtrinsicFailed`: its outcome is only in the `result`
 * of its `Dispatched` event, and `task` holds the call's position in the agenda.
 */
async function getDispatchedEvents(client: Client<any, any>) {
  const events = await client.api.query.system.events()
  return events.flatMap(({ event }) => (client.api.events.scheduler.Dispatched.is(event) ? [event.data] : []))
}

/**
 * Test: child curator self-unassign refunds deposit
 *
 * This test verifies that child curators can self-unassign if they are not able to do the work assigned to them
 * and have their deposit refunded.
 *
 * Test structure:
 * 1. Create parent bounty and make it active with Bob as curator
 * 2. Create an active child bounty with Charlie as curator
 * 3. Charlie self-unassigns (should refund deposit)
 * 4. Verify child bounty status is back to Added
 */
export async function childBountyUnassignCuratorSelfUnassignRefundsDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create and activate parent bounty with Bob as curator =====

  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Test bounty for self-unassign refund',
    testAccounts.bob,
  )

  // ===== SECTION 2: Create and activate child bounty with Charlie as curator =====

  const { parentIndex, childIndex } = await createActiveChildBountyWithCurator(
    client,
    bountyIndex,
    testAccounts.bob,
    'Self-unassign refund child bounty',
    testAccounts.charlie,
  )

  // ===== SECTION 3: Charlie self-unassigns (should refund deposit) =====

  // Charlie's only reserved funds are the curator deposit recorded on the child bounty
  const curatorDeposit = (await getChildBounty(client, parentIndex, childIndex)).curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  const charlieAccountBeforeSelfUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  const freeBalanceBeforeSelfUnassign = charlieAccountBeforeSelfUnassign.data.free.toBigInt()
  expect(charlieAccountBeforeSelfUnassign.data.reserved.toBigInt()).toBe(curatorDeposit)

  // Child curator self-unassigns (should refund deposit)
  const unassignCuratorTx1 = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx1.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // ===== SECTION 4: Verify child bounty status is back to Added and deposit is refunded =====

  // the whole deposit moved from reserved back to free; the only other change to Charlie's free balance is the
  // fee of the unassign call
  const unassignFee = await getFeePaidBy(client, testAccounts.charlie.address)
  const charlieAccountAfterSelfUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAccountAfterSelfUnassign.data.reserved.toBigInt()).toBe(0n)
  expect(charlieAccountAfterSelfUnassign.data.free.toBigInt()).toBe(
    freeBalanceBeforeSelfUnassign + curatorDeposit - unassignFee,
  )

  // nothing was slashed
  const slashedEvents = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.balances.Slashed.is(event),
  )
  expect(slashedEvents).toHaveLength(0)

  // Verify child bounty status is back to Added, with no deposit recorded
  const unassignedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(unassignedChildBounty.status.isAdded).toBe(true)
  expect(unassignedChildBounty.curatorDeposit.toBigInt()).toBe(0n)
}

/**
 * Test: parent curator unassignment slashes child curator deposit
 *
 * This test verifies that parent curators can unassign child curators if the curator is not doing their job properly or maliciously
 * and have their deposit slashed.
 *
 * Test structure:
 * 1. Create parent bounty and make it active with Bob as curator
 * 2. Create an active child bounty with Charlie as curator
 * 3. Bob unassigns Charlie (should slash deposit)
 * 4. Verify child bounty status is Added, Charlie's reserve balance is slashed, and the slashed deposit reached the
 *    chain's slash sink
 */
export async function childBountyUnassignCuratorParentUnassignSlashesDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create and activate parent bounty with Bob as curator =====

  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Test bounty for parent-unassign slash',
    testAccounts.bob,
  )

  // ===== SECTION 2: Create and activate child bounty with Charlie as curator =====

  const { parentIndex, childIndex } = await createActiveChildBountyWithCurator(
    client,
    bountyIndex,
    testAccounts.bob,
    'Parent-unassign slash child bounty',
    testAccounts.charlie,
  )

  // ===== SECTION 3: Bob unassigns Charlie (should slash deposit) =====

  // Charlie's only reserved funds are the curator deposit recorded on the child bounty
  const curatorDeposit = (await getChildBounty(client, parentIndex, childIndex)).curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  const charlieBefore = await client.api.query.system.account(testAccounts.charlie.address)
  const charlieFreeBalanceBefore = charlieBefore.data.free.toBigInt()
  expect(charlieBefore.data.reserved.toBigInt()).toBe(curatorDeposit)

  const unassignCuratorTx = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 4: Verify child bounty status is Added, Charlie's reserve balance is slashed, and the deposit reached the slash sink =====

  await checkSystemEvents(
    client,
    { section: 'balances', method: 'Slashed' },
    { section: 'treasury', method: 'Deposit' },
  ).toMatchSnapshot('parent curator unassign: slash events')

  // the whole deposit was slashed from Charlie and reached the chain's slash sink
  await expectCuratorSlashedToSink(client, testConfig, testAccounts.charlie.address, curatorDeposit)

  // the slash came out of Charlie's reserved balance, and Bob paid the fee, so Charlie's free balance is unchanged
  const charlieAfter = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfter.data.reserved.toBigInt()).toBe(0n)
  expect(charlieAfter.data.free.toBigInt()).toBe(charlieFreeBalanceBefore)

  const unassignedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(unassignedChildBounty.status.isAdded).toBe(true)
  expect(unassignedChildBounty.curatorDeposit.toBigInt()).toBe(0n)
}

/**
 * Test: public user unassign curator fails with Premature error
 *
 * This test verifies that public users cannot unassign child curators if the child bounty is active (premature)
 * and fails with Premature error.
 *
 * Test structure:
 * 1. Create parent bounty and make it active with Bob as curator
 * 2. Create an active child bounty with Charlie as curator
 * 3. Public user (Dave) tries to unassign Charlie immediately i.e active child bounty (premature)
 * 4. Verify the transaction fails with Premature error
 * 5. Verify child bounty is still in storage and still Active
 */
export async function childBountyUnassignCuratorPublicUserPrematureFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create and activate parent bounty with Bob as curator =====

  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Test bounty for public user unassign premature',
    testAccounts.bob,
  )

  // ===== SECTION 2: Create and activate child bounty with Charlie as curator =====

  const { parentIndex, childIndex } = await createActiveChildBountyWithCurator(
    client,
    bountyIndex,
    testAccounts.bob,
    'Unauthorized unassign premature child bounty',
    testAccounts.charlie,
  )

  // ===== SECTION 3: Public user (Dave) tries to unassign Charlie immediately i.e active child bounty (premature) =====

  const unassignCuratorTx = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.dave)) // public user tries to unassign curator immediately i.e active child bounty (premature)

  await client.dev.newBlock()

  // ===== SECTION 4: Verify the transaction fails with Premature error =====

  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.Premature.is(dispatchError.asModule)).toBeTruthy()

  // ===== SECTION 5: Verify child bounty is still in storage and still Active =====

  // Verify child bounty is still in storage and still Active
  const unassignedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(unassignedChildBounty).toBeTruthy()
  expect(unassignedChildBounty.status.isActive).toBe(true)
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create parent bounty and make it active =====

  const description = 'Test bounty for storage verification'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // ===== SECTION 2: Create multiple child bounties and verify storage updates =====

  // Create first child bounty
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue1 = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription1 = 'First child bounty for storage test'

  const addChildBountyTx1 = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue1,
    childBountyDescription1,
  )
  await sendTransaction(addChildBountyTx1.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex: parentIndex1, childIndex: childIndex1 } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty1 = await getChildBounty(client, parentIndex1, childIndex1)
  expect(childBounty1.status.isAdded).toBe(true)

  // Verify storage items
  let activeCount = await getParentChildBountiesCount(client, parentIndex1)
  expect(activeCount).toBe(1)

  const totalCount = await client.api.query.childBounties.parentTotalChildBounties(parentIndex1)
  expect(totalCount.toNumber()).toBe(1)

  const childBountyDesc1 = await getChildBountyDescription(client, parentIndex1, childIndex1)
  expect(childBountyDesc1).toBe(childBountyDescription1)

  // Create second child bounty
  const childBountyValue2 = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription2 = 'Second child bounty for storage test'

  const addChildBountyTx2 = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue2,
    childBountyDescription2,
  )
  await sendTransaction(addChildBountyTx2.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex: parentIndex2, childIndex: childIndex2 } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty2 = await getChildBounty(client, parentIndex2, childIndex2)
  expect(childBounty2.status.isAdded).toBe(true)

  // Verify storage items updated
  activeCount = await getParentChildBountiesCount(client, parentIndex2)
  expect(activeCount).toBe(2)

  const totalCount2 = await client.api.query.childBounties.parentTotalChildBounties(parentIndex2)
  expect(totalCount2.toNumber()).toBe(2)

  const childBountyDesc2 = await getChildBountyDescription(client, parentIndex2, childIndex2)
  expect(childBountyDesc2).toBe(childBountyDescription2)

  // ===== SECTION 3: Complete one child bounty (award and claim) and verify storage cleanup =====

  // Assign and accept curator for first child bounty
  const childCuratorFee1 = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
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

  // Verify child bounty is active
  const activeChildBounty1 = await getChildBounty(client, parentIndex1, childIndex1)
  expect(activeChildBounty1.status.isActive).toBe(true)

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

  // ===== SECTION 4: Verify counters and remaining storage items are correct =====

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
}

/**
 * Once the parent bounty's update is overdue, anyone can unassign an active child curator, and the curator's
 * deposit is slashed.
 *
 * The pallet reads an overdue parent bounty as a sign that the child curator is inactive. The parent's
 * `update_due` is a block number of the treasury's block provider, set one `BountyUpdatePeriod` after the parent
 * curator accepted. That period is years long on these runtimes, further than a test can build blocks, so the
 * test moves `update_due` to the current block in storage. The unassign is a real extrinsic from an account with
 * no role.
 *
 * 1. Create an active parent bounty (Bob) with an active child bounty (Charlie)
 * 2. Verify the parent's `update_due` is in the future, then move it to the current block
 * 3. Eve, who has no role, unassigns the child curator
 * 4. Verify Charlie's deposit was slashed and reached the chain's slash sink
 * 5. Verify the child bounty is back to Added with no deposit, and Charlie's reserve is empty
 */
export async function childBountyUnassignCuratorPublicAfterUpdateDueTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig) {
  // 1. Active parent bounty and active child bounty
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'eve'])
  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Parent bounty with an overdue update',
    testAccounts.bob,
  )
  const { parentIndex, childIndex } = await createActiveChildBountyWithCurator(
    client,
    bountyIndex,
    testAccounts.bob,
    'Child bounty with an inactive curator',
    testAccounts.charlie,
  )

  // Charlie's only reserved funds are the curator deposit recorded on the child bounty
  const curatorDeposit = (await getChildBounty(client, parentIndex, childIndex)).curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  const charlieBefore = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieBefore.data.reserved.toBigInt()).toBe(curatorDeposit)

  // 2. `update_due` starts in the future, and is moved to the current block. The unassign runs in the next block,
  // where the block provider reports a higher number, so the update is overdue by then.
  const parentBounty = await getBounty(client, parentIndex)
  const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  assert(parentBounty.status.isActive)
  expect(parentBounty.status.asActive.updateDue.toNumber()).toBeGreaterThan(currentBlock)

  const overdueParentBounty = {
    ...parentBounty.toJSON(),
    status: { active: { curator: parentBounty.status.asActive.curator.toJSON(), updateDue: currentBlock } },
  }
  await client.dev.setStorage({
    Bounties: {
      bounties: [[[parentIndex], overdueParentBounty]],
    },
  })
  expect((await getBounty(client, parentIndex)).toJSON()).toEqual(overdueParentBounty)

  // 3. Eve unassigns the child curator
  const unassignCuratorTx = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.eve))
  await client.dev.newBlock()

  // 4. Deposit slashed to the sink
  await checkSystemEvents(
    client,
    { section: 'balances', method: 'Slashed' },
    { section: 'treasury', method: 'Deposit' },
  ).toMatchSnapshot('public unassign: slash events')
  await expectCuratorSlashedToSink(client, testConfig, testAccounts.charlie.address, curatorDeposit)

  // 5. Back to Added, nothing left in reserve. Eve paid the fee, so Charlie's free balance is unchanged.
  const unassignedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(unassignedChildBounty.status.isAdded).toBe(true)
  expect(unassignedChildBounty.curatorDeposit.toBigInt()).toBe(0n)

  const charlieAfter = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfter.data.reserved.toBigInt()).toBe(0n)
  expect(charlieAfter.data.free.toBigInt()).toBe(charlieBefore.data.free.toBigInt())
}

/**
 * The parent curator can unassign a child curator who has only been proposed, and one who has already awarded
 * the child bounty.
 *
 * A proposed curator has reserved nothing, so withdrawing the proposal costs them nothing. A curator who awarded
 * has a deposit at stake, and unassigning at that point means the parent curator disputes the award: the deposit
 * is slashed and the award is undone.
 *
 * 1. Build a parent bounty with one child bounty in each status
 * 2. Bob, the parent curator, unassigns the proposed curator
 * 3. Verify that child bounty is back to Added and nothing was slashed
 * 4. Bob unassigns the curator of the awarded child bounty
 * 5. Verify that deposit was slashed and reached the chain's slash sink
 * 6. Verify the awarded child bounty is back to Added, and Charlie still holds the deposit of the active one
 */
export async function childBountyUnassignCuratorParentCuratorOtherStatusesTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig) {
  // 1. One child bounty per status. Charlie holds one deposit for the active one and one for the awarded one.
  const { parentIndex, curatorProposed, active, pendingPayout, curatorDeposit } =
    await createChildBountiesInEveryStatus(client)

  // 2. Bob unassigns the proposed curator
  const unassignProposedTx = client.api.tx.childBounties.unassignCurator(parentIndex, curatorProposed)
  await sendTransaction(unassignProposedTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 3. Back to Added, nothing slashed
  const unassignedProposedChild = await getChildBounty(client, parentIndex, curatorProposed)
  expect(unassignedProposedChild.status.isAdded).toBe(true)
  const slashedEvents = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.balances.Slashed.is(event),
  )
  expect(slashedEvents).toHaveLength(0)
  const charlieAfterProposedUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfterProposedUnassign.data.reserved.toBigInt()).toBe(2n * curatorDeposit)

  // 4. Bob unassigns the curator of the awarded child bounty
  const unassignAwardedTx = client.api.tx.childBounties.unassignCurator(parentIndex, pendingPayout)
  await sendTransaction(unassignAwardedTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 5. Deposit slashed to the sink
  await checkSystemEvents(
    client,
    { section: 'balances', method: 'Slashed' },
    { section: 'treasury', method: 'Deposit' },
  ).toMatchSnapshot('parent curator unassign of awarded child bounty: slash events')
  await expectCuratorSlashedToSink(client, testConfig, testAccounts.charlie.address, curatorDeposit)

  // 6. Award undone, and only the active child bounty's deposit is left in reserve
  const unassignedAwardedChild = await getChildBounty(client, parentIndex, pendingPayout)
  expect(unassignedAwardedChild.status.isAdded).toBe(true)
  expect(unassignedAwardedChild.curatorDeposit.toBigInt()).toBe(0n)

  const activeChild = await getChildBounty(client, parentIndex, active)
  expect(activeChild.status.isActive).toBe(true)
  expect(activeChild.curatorDeposit.toBigInt()).toBe(curatorDeposit)
  const charlieAfterAwardedUnassign = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfterAwardedUnassign.data.reserved.toBigInt()).toBe(curatorDeposit)
}

/**
 * The treasury's `RejectOrigin` can unassign a child curator in every status that has one, and it slashes any
 * deposit the curator holds.
 *
 * `RejectOrigin` is Root or the `Treasurer` track on these runtimes, and both are used here. Each call is
 * injected into the scheduler's agenda in its own block, so its outcome is the `result` of a
 * `scheduler.Dispatched` event.
 *
 * 1. Build a parent bounty with one child bounty in each status
 * 2. Root unassigns the proposed curator
 * 3. Verify the call was dispatched, the child bounty is back to Added, and nothing was slashed
 * 4. Treasurer unassigns the curator of the active child bounty
 * 5. Verify the call was dispatched, the deposit was slashed to the slash sink, and the child bounty is Added
 * 6. Root unassigns the curator of the awarded child bounty
 * 7. Verify the call was dispatched, the deposit was slashed to the slash sink, and the child bounty is Added
 * 8. Verify Charlie's reserve is empty
 */
export async function childBountyUnassignCuratorRejectOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig) {
  // 1. One child bounty per status. Charlie holds one deposit for the active one and one for the awarded one.
  const { parentIndex, curatorProposed, active, pendingPayout, curatorDeposit } =
    await createChildBountiesInEveryStatus(client)

  // 2. Root unassigns the proposed curator
  const unassignProposedTx = client.api.tx.childBounties.unassignCurator(parentIndex, curatorProposed)
  await scheduleInlineCallWithOrigin(
    client,
    unassignProposedTx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched, back to Added, nothing slashed
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('root unassign of proposed curator: scheduler dispatched event')
  const proposedDispatched = await getDispatchedEvents(client)
  expect(proposedDispatched).toHaveLength(1)
  expect(proposedDispatched[0].result.isOk).toBe(true)

  const unassignedProposedChild = await getChildBounty(client, parentIndex, curatorProposed)
  expect(unassignedProposedChild.status.isAdded).toBe(true)
  const slashedEvents = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.balances.Slashed.is(event),
  )
  expect(slashedEvents).toHaveLength(0)

  // 4. Treasurer unassigns the curator of the active child bounty
  const unassignActiveTx = client.api.tx.childBounties.unassignCurator(parentIndex, active)
  await scheduleInlineCallWithOriginTreasurer(client, unassignActiveTx.method.toHex())
  await client.dev.newBlock()

  // 5. Dispatched, deposit slashed to the sink, back to Added
  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: 'balances', method: 'Slashed' },
    { section: 'treasury', method: 'Deposit' },
  )
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('treasurer unassign of active curator: dispatched and slash events')
  const activeDispatched = await getDispatchedEvents(client)
  expect(activeDispatched).toHaveLength(1)
  expect(activeDispatched[0].result.isOk).toBe(true)
  await expectCuratorSlashedToSink(client, testConfig, testAccounts.charlie.address, curatorDeposit)

  const unassignedActiveChild = await getChildBounty(client, parentIndex, active)
  expect(unassignedActiveChild.status.isAdded).toBe(true)
  expect(unassignedActiveChild.curatorDeposit.toBigInt()).toBe(0n)

  // 6. Root unassigns the curator of the awarded child bounty
  const unassignAwardedTx = client.api.tx.childBounties.unassignCurator(parentIndex, pendingPayout)
  await scheduleInlineCallWithOrigin(
    client,
    unassignAwardedTx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 7. Dispatched, deposit slashed to the sink, back to Added
  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: 'balances', method: 'Slashed' },
    { section: 'treasury', method: 'Deposit' },
  )
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('root unassign of awarded curator: dispatched and slash events')
  const awardedDispatched = await getDispatchedEvents(client)
  expect(awardedDispatched).toHaveLength(1)
  expect(awardedDispatched[0].result.isOk).toBe(true)
  await expectCuratorSlashedToSink(client, testConfig, testAccounts.charlie.address, curatorDeposit)

  const unassignedAwardedChild = await getChildBounty(client, parentIndex, pendingPayout)
  expect(unassignedAwardedChild.status.isAdded).toBe(true)
  expect(unassignedAwardedChild.curatorDeposit.toBigInt()).toBe(0n)

  // 8. Both deposits are gone from Charlie's reserve
  const charlieAfter = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfter.data.reserved.toBigInt()).toBe(0n)
}

/**
 *  All unassign child bounty curator tests
 *
 * @param getClient Returns the client shared by the suite
 * @param testConfig Configuration of the child bounties suite
 * @returns The tree of unassign tests
 */
export function allUnassignChildBountyCuratorTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(getClient: () => Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'All unassign child bounty curator tests',
    children: [
      {
        kind: 'test',
        label: 'child curator self-unassign refunds deposit',
        testFn: async () => await childBountyUnassignCuratorSelfUnassignRefundsDepositTest(getClient()),
      },
      {
        kind: 'test',
        label: 'parent curator unassign slashes child curator deposit',
        testFn: async () => await childBountyUnassignCuratorParentUnassignSlashesDepositTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'public user unassign curator fails with Premature error',
        testFn: async () => await childBountyUnassignCuratorPublicUserPrematureFailsTest(getClient()),
      },
      {
        kind: 'test',
        label: 'public unassign after parent update_due - child curator deposit slashed',
        testFn: async () => await childBountyUnassignCuratorPublicAfterUpdateDueTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'parent curator unassign in CuratorProposed and PendingPayout - back to Added, PendingPayout slashed',
        testFn: async () => await childBountyUnassignCuratorParentCuratorOtherStatusesTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'unassign by RejectOrigin in every curator state - deposit slashed where held',
        testFn: async () => await childBountyUnassignCuratorRejectOriginTest(getClient(), testConfig),
      },
    ],
  } as RootTestTree
}

/**
 * The parent curator can award a child bounty that has its own curator.
 *
 * `award_child_bounty` accepts the child curator or the parent curator. This is the parent curator's way to pay a
 * beneficiary when the child curator does not act. The pallet sets the unlock block to the current block of the
 * treasury's block provider plus `BountyDepositPayoutDelay`.
 *
 * The test does not check which account the pending payout records as its curator. The pallet records the
 * account that awarded rather than the child curator, which is a known bug
 * (https://github.com/paritytech/polkadot-sdk/issues/12190), so that field changes once the fix reaches the
 * runtime.
 *
 * 1. Create an active parent bounty (Bob) with an active child bounty (Charlie)
 * 2. Bob, the parent curator, awards the child bounty to Dave
 * 3. Verify the Awarded event names the child bounty and Dave
 * 4. Verify the child bounty is PendingPayout for Dave, unlocking at the award block plus the payout delay
 * 5. Verify Charlie's deposit is still recorded and reserved
 */
export async function childBountyAwardByParentCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // 1. Active parent bounty and active child bounty
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])
  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Parent bounty whose curator awards a child bounty',
    testAccounts.bob,
  )
  const { parentIndex, childIndex } = await createActiveChildBountyWithCurator(
    client,
    bountyIndex,
    testAccounts.bob,
    'Child bounty awarded by the parent curator',
    testAccounts.charlie,
  )
  const curatorDeposit = (await getChildBounty(client, parentIndex, childIndex)).curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)

  // 2. Bob awards to Dave
  const awardTx = client.api.tx.childBounties.awardChildBounty(parentIndex, childIndex, testAccounts.dave.address)
  await sendTransaction(awardTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 3. Awarded event
  await checkSystemEvents(client, { section: 'childBounties', method: 'Awarded' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('award by parent curator: awarded event')
  const awardedEvents = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Awarded.is(event) ? [event.data] : [],
  )
  expect(awardedEvents).toHaveLength(1)
  expect(awardedEvents[0].index.toNumber()).toBe(parentIndex)
  expect(awardedEvents[0].childIndex.toNumber()).toBe(childIndex)
  expect(awardedEvents[0].beneficiary.eq(testAccounts.dave.address)).toBe(true)

  // 4. PendingPayout for Dave. The award ran in the latest block, so the block provider's current number is the
  // block the pallet saw.
  const awardedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  assert(awardedChildBounty.status.isPendingPayout)
  const { beneficiary, unlockAt } = awardedChildBounty.status.asPendingPayout
  expect(beneficiary.eq(testAccounts.dave.address)).toBe(true)
  const awardBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  expect(unlockAt.toNumber()).toBe(awardBlock + client.api.consts.bounties.bountyDepositPayoutDelay.toNumber())

  // 5. Charlie's deposit is untouched
  expect(awardedChildBounty.curatorDeposit.toBigInt()).toBe(curatorDeposit)
  const charlieAccount = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAccount.data.reserved.toBigInt()).toBe(curatorDeposit)
}

/**
 * A parent curator who takes the child curator role themselves reserves no deposit.
 *
 * The child curator deposit protects the parent curator's bounty from a bad child curator. When both roles are
 * the same account there is nobody to protect, and that account already holds the parent bounty's curator
 * deposit, so the pallet sets the child curator deposit to zero.
 *
 * 1. Create an active parent bounty curated by Bob
 * 2. Bob adds a child bounty and proposes himself as its curator
 * 3. Bob accepts
 * 4. Verify the child bounty is Active with Bob as curator and a zero deposit
 * 5. Verify Bob's reserved balance did not change
 */
export async function childBountyParentCuratorAsChildCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // 1. Active parent bounty
  await setupTestAccounts(client, ['alice', 'bob'])
  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Parent bounty whose curator also curates a child bounty',
    testAccounts.bob,
  )

  // 2. Bob adds a child bounty and proposes himself
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    bountyValueMinimum * CHILD_BOUNTY_MULTIPLIER,
    'Child bounty curated by the parent curator',
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()
  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  const proposeCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    childIndex,
    testAccounts.bob.address,
    bountyValueMinimum * CHILD_CURATOR_FEE_MULTIPLIER,
  )
  await sendTransaction(proposeCuratorTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  const proposedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  assert(proposedChildBounty.status.isCuratorProposed)
  expect(proposedChildBounty.status.asCuratorProposed.curator.eq(testAccounts.bob.address)).toBe(true)

  // Bob's reserve at this point is the curator deposit of the parent bounty
  const bobBefore = await client.api.query.system.account(testAccounts.bob.address)
  const parentCuratorDeposit = (await getBounty(client, parentIndex)).curatorDeposit.toBigInt()
  expect(parentCuratorDeposit).toBeGreaterThan(0n)
  expect(bobBefore.data.reserved.toBigInt()).toBe(parentCuratorDeposit)

  // 3. Bob accepts
  const acceptCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)
  await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 4. Active, curated by Bob, zero deposit
  const activeChildBounty = await getChildBounty(client, parentIndex, childIndex)
  assert(activeChildBounty.status.isActive)
  expect(activeChildBounty.status.asActive.curator.eq(testAccounts.bob.address)).toBe(true)
  expect(activeChildBounty.curatorDeposit.toBigInt()).toBe(0n)

  // 5. Nothing more reserved
  const bobAfter = await client.api.query.system.account(testAccounts.bob.address)
  expect(bobAfter.data.reserved.toBigInt()).toBe(parentCuratorDeposit)
}

/**
 * The treasury's `RejectOrigin` can close a child bounty, and closing never slashes.
 *
 * `RejectOrigin` is Root or the `Treasurer` track on these runtimes, and both are used here. Closing sends the
 * child bounty's funds back to the parent bounty account. If the child bounty has an active curator, the curator
 * did nothing wrong by having the work cancelled, so the deposit is unreserved, and the curator's fee stops
 * counting against the parent curator's fee. Each call is injected into the scheduler's agenda in its own block.
 *
 * 1. Build a parent bounty with one child bounty in each status
 * 2. Root closes the child bounty that has no curator
 * 3. Verify the call was dispatched, Canceled was emitted, the value is back in the parent bounty account, and the
 *    child bounty is gone
 * 4. Treasurer closes the active child bounty
 * 5. Verify the call was dispatched, Canceled was emitted, the value is back in the parent bounty account, and the
 *    child bounty is gone
 * 6. Verify Charlie's deposit for it was unreserved and not slashed, and its fee left the parent's fee total
 */
export async function childBountyCloseByRejectOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // 1. One child bounty per status. Three of the four had a curator proposed, each with the same fee.
  const { parentIndex, added, active, childValue, childFee, curatorDeposit } =
    await createChildBountiesInEveryStatus(client)
  const parentAccount = bountyAccount(client, parentIndex)
  const parentBalanceBefore = await getFreeBalance(client, parentAccount)
  expect(await getFreeBalance(client, childBountyAccount(client, parentIndex, added))).toBe(childValue)
  expect(await getFreeBalance(client, childBountyAccount(client, parentIndex, active))).toBe(childValue)
  expect(await getParentChildBountiesCount(client, parentIndex)).toBe(4)
  expect((await client.api.query.childBounties.childrenCuratorFees(parentIndex)).toBigInt()).toBe(3n * childFee)

  // 2. Root closes the child bounty in Added
  const closeAddedTx = client.api.tx.childBounties.closeChildBounty(parentIndex, added)
  await scheduleInlineCallWithOrigin(
    client,
    closeAddedTx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched, Canceled, value returned, child bounty gone
  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: 'childBounties', method: 'Canceled' },
  )
    .redact({ redactKeys: /^(task|index)$/ })
    .toMatchSnapshot('root close of child bounty without curator: dispatched and canceled events')
  const addedDispatched = await getDispatchedEvents(client)
  expect(addedDispatched).toHaveLength(1)
  expect(addedDispatched[0].result.isOk).toBe(true)

  const addedCanceled = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Canceled.is(event) ? [event.data] : [],
  )
  expect(addedCanceled).toHaveLength(1)
  expect(addedCanceled[0].index.toNumber()).toBe(parentIndex)
  expect(addedCanceled[0].childIndex.toNumber()).toBe(added)

  expect(await getFreeBalance(client, parentAccount)).toBe(parentBalanceBefore + childValue)
  expect(await getFreeBalance(client, childBountyAccount(client, parentIndex, added))).toBe(0n)
  expect(await getChildBounty(client, parentIndex, added)).toBeNull()
  expect(await getChildBountyDescription(client, parentIndex, added)).toBeNull()
  expect(await getParentChildBountiesCount(client, parentIndex)).toBe(3)

  // 4. Treasurer closes the active child bounty
  const charlieBefore = await client.api.query.system.account(testAccounts.charlie.address)
  const closeActiveTx = client.api.tx.childBounties.closeChildBounty(parentIndex, active)
  await scheduleInlineCallWithOriginTreasurer(client, closeActiveTx.method.toHex())
  await client.dev.newBlock()

  // 5. Dispatched, Canceled, value returned, child bounty gone
  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: 'childBounties', method: 'Canceled' },
  )
    .redact({ redactKeys: /^(task|index)$/ })
    .toMatchSnapshot('treasurer close of active child bounty: dispatched and canceled events')
  const activeDispatched = await getDispatchedEvents(client)
  expect(activeDispatched).toHaveLength(1)
  expect(activeDispatched[0].result.isOk).toBe(true)

  const activeCanceled = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Canceled.is(event) ? [event.data] : [],
  )
  expect(activeCanceled).toHaveLength(1)
  expect(activeCanceled[0].index.toNumber()).toBe(parentIndex)
  expect(activeCanceled[0].childIndex.toNumber()).toBe(active)

  expect(await getFreeBalance(client, parentAccount)).toBe(parentBalanceBefore + 2n * childValue)
  expect(await getFreeBalance(client, childBountyAccount(client, parentIndex, active))).toBe(0n)
  expect(await getChildBounty(client, parentIndex, active)).toBeNull()
  expect(await getChildBountyDescription(client, parentIndex, active)).toBeNull()
  expect(await getParentChildBountiesCount(client, parentIndex)).toBe(2)

  // 6. Deposit unreserved, not slashed, and the fee no longer counted
  const slashedEvents = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.balances.Slashed.is(event),
  )
  expect(slashedEvents).toHaveLength(0)
  const charlieAfter = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfter.data.reserved.toBigInt()).toBe(charlieBefore.data.reserved.toBigInt() - curatorDeposit)
  expect(charlieAfter.data.free.toBigInt()).toBe(charlieBefore.data.free.toBigInt() + curatorDeposit)
  expect((await client.api.query.childBounties.childrenCuratorFees(parentIndex)).toBigInt()).toBe(2n * childFee)
}

/**
 * All child bounty success tests
 *
 */
export function allChildBountiesSuccessTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(getClient: () => Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'All child bounties success tests',
    children: [
      {
        kind: 'test',
        label: 'child bounty creation',
        testFn: async () => await childBountyCreationTest(getClient()),
      },
      {
        kind: 'test',
        label: 'assigning and accepting a child bounty curator',
        testFn: async () => await childBountyAssigningAndAcceptingTest(getClient()),
      },
      {
        kind: 'test',
        label: 'awarding and claiming a child bounty',
        testFn: async () => await childBountyAwardingAndClaimingTest(getClient()),
      },
      {
        kind: 'test',
        label: 'closure and payout of a child bounty',
        testFn: async () => await childBountyClosureAndPayoutTest(getClient()),
      },
      {
        kind: 'test',
        label: 'rejection by child curator and closure by parent curator of a child bounty',
        testFn: async () => await childBountyRejectionAndCancellationTest(getClient()),
      },
      {
        kind: 'test',
        label: 'child bounty storage verification',
        testFn: async () => await childBountyStorageVerificationTest(getClient()),
      },
      {
        kind: 'test',
        label: 'award by parent curator - Awarded, PendingPayout',
        testFn: async () => await childBountyAwardByParentCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'parent curator accepts own child curatorship - zero deposit',
        testFn: async () => await childBountyParentCuratorAsChildCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'close by RejectOrigin - value back to parent, deposit unreserved',
        testFn: async () => await childBountyCloseByRejectOriginTest(getClient()),
      },
      allUnassignChildBountyCuratorTests(getClient, testConfig),
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for error testing'

  // ===== SECTION 1: Create parent bounty but don't activate it (leave it in Proposed state) =====

  // Create parent bounty but don't activate it
  const proposeBountyTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  await sendTransaction(proposeBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  const bountyIndex = await getBountyIndexFromEvent(client)

  // ===== SECTION 2: Attempt to create child bounty from the non-active parent bounty =====

  // Try to create child bounty while parent is still Proposed (not active)
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty that should fail'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )

  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 3: Verify the transaction fails with ParentBountyNotActive error =====

  // Check the result of dispatched event
  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.childBounties.ParentBountyNotActive.is(dispatchError.asModule)).toBeTruthy()
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
 * 1. Create active parent bounty
 * 2. Attempt to create child bounty with value larger than parent bounty balance
 * 3. Verify the transaction fails with `InsufficientBountyBalance` error
 */
export async function childBountyInsufficientBountyBalanceErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create active parent bounty with a specific value =====

  const description = 'Test bounty with minimal value'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // ===== SECTION 2: Attempt to create child bounty with value larger than parent bounty balance =====

  // Try to create child bounty with value larger than parent bounty balance
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const parentBountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const childBountyValue = parentBountyValue + 1n // Larger than parent bounty
  const childBountyDescription = 'Test child bounty that should fail'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )

  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 3: Verify the transaction fails with InsufficientBountyBalance error =====

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.childBounties.InsufficientBountyBalance.is(dispatchError.asModule)).toBeTruthy()
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
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create active parent bounty =====

  const description = 'Test bounty for invalid value testing'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // ===== SECTION 2: Attempt to create child bounty with value below the minimum threshold =====

  // Get minimum child bounty value
  const childBountyValueMinimum = client.api.consts.childBounties.childBountyValueMinimum

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

  // ===== SECTION 3: Verify the transaction fails with InvalidValue error =====

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidValue.is(dispatchError.asModule)).toBeTruthy()
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
 * 1. Create active parent bounty and add a child bounty
 * 2. Attempt to propose curator with fee >= child bounty value
 * 3. Verify the transaction fails with `InvalidFee` error
 */
export async function childBountyInvalidFeeErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create active parent bounty and add a child bounty =====

  const description = 'Test bounty for invalid fee testing'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // Create child bounty
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for invalid fee'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // ===== SECTION 2: Attempt to propose curator with fee >= child bounty value =====

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

  // ===== SECTION 3: Verify the transaction fails with InvalidFee error =====

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidFee.is(dispatchError.asModule)).toBeTruthy()
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
 * 1. Create active parent bounty and add a child bounty
 * 2. Attempt to accept curator when child bounty is in Added status (not `CuratorProposed`)
 * 3. Verify the transaction fails with `UnexpectedStatus` error
 */
export async function childBountyUnexpectedStatusErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create active parent bounty and add a child bounty =====

  const description = 'Test bounty for unexpected status testing'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // Create child bounty
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for unexpected status'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // ===== SECTION 2: Attempt to accept curator when child bounty is in Added status (not CuratorProposed) =====

  // Try to accept curator when child bounty is in Added status (not CuratorProposed)
  const acceptChildCuratorTx = client.api.tx.childBounties.acceptCurator(parentIndex, childIndex)

  await sendTransaction(acceptChildCuratorTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // ===== SECTION 3: Verify the transaction fails with UnexpectedStatus error =====

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.UnexpectedStatus.is(dispatchError.asModule)).toBeTruthy()
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
 * 1. Create active parent bounty and add a child bounty
 * 2. Award child bounty to beneficiary (transitions to `PendingPayout`)
 * 3. Attempt to close child bounty while in `PendingPayout` status
 * 4. Verify the transaction fails with `PendingPayout` error
 */
export async function childBountyPendingPayoutErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  // ===== SECTION 1: Create active parent bounty and add a child bounty =====

  const description = 'Test bounty for pending payout testing'
  const bountyIndex = await createActiveParentBountyWithCurator(client, description, testAccounts.bob)

  // Create child bounty
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
  const childBountyDescription = 'Test child bounty for pending payout testing'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // Assign and accept curator for child bounty
  const childCuratorFee = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
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

  // ===== SECTION 2: Award child bounty to beneficiary (transitions to PendingPayout) =====

  // Award child bounty
  const awardChildBountyTx = client.api.tx.childBounties.awardChildBounty(
    parentIndex,
    childIndex,
    testAccounts.dave.address,
  )
  await sendTransaction(awardChildBountyTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // ===== SECTION 3: Attempt to close child bounty while in PendingPayout status =====

  // Try to close child bounty in PendingPayout status
  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex)

  await sendTransaction(closeChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 4: Verify the transaction fails with PendingPayout error =====

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.PendingPayout.is(dispatchError.asModule)).toBeTruthy()
}

/**
 * Test: non-curator trying to create child bounty throws `RequireCurator` error
 *
 * This test verifies the `RequireCurator` error condition to ensure that:
 * - Non-curator accounts cannot create child bounties
 * - The system prevents unauthorized creation of child bounties
 * - Proper authorization is enforced for child bounty operations
 *
 * Test structure:
 * 1. Create active parent bounty and add a child bounty
 * 2. Attempt to create child bounty with non-curator account
 * 3. Verify the transaction fails with `RequireCurator` error
 */
export async function childBountyRequireCuratorErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for child bounty creation'

  // ===== SECTION 1: Create active parent bounty and child bounty =====

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
  await scheduleInlineCallWithOriginTreasurer(client, approveBountyTx.method.toHex())

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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOriginTreasurer(client, proposeCuratorTx.method.toHex())

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

  // ===== SECTION 2: Attempt to create child bounty with non-curator account =====

  // Note: The curator (Bob) should create the child bounty, not Alice
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER // Smaller value for child bounty
  const childBountyDescription = 'Test child bounty'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.charlie))

  await client.dev.newBlock()

  // ===== SECTION 3: Verify the transaction fails with RequireCurator error =====

  const ev = await extractExtrinsicFailedEvent(client)

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.RequireCurator.is(dispatchError.asModule)).toBeTruthy()
}

/**
 * Test: parent already has `MaxActiveChildBountyCount` child bounties, trying to create a new one throws `TooManyChildBounties` error
 *
 * This test verifies the `TooManyChildBounties` error condition to ensure that:
 * - The system prevents creating more child bounties than the allowed limit
 * - Proper error handling occurs when attempting to create too many child bounties
 * - The limit counts active child bounties, so closing one makes room for a new one
 *
 * The limit is reached with real `add_child_bounty` calls, so the active count the runtime checks is backed by
 * that many child bounties in storage.
 *
 * Test structure:
 * 1. Create active parent bounty
 * 2. Bob adds `maxActiveChildBountyCount` child bounties in one batch
 * 3. Attempt to add one more child bounty
 * 4. Verify the transaction fails with `TooManyChildBounties` error and nothing changed
 * 5. Bob closes one child bounty, then adds a child bounty again, which succeeds
 */
export async function childBountyTooManyChildBountiesErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for child bounty creation'

  // ===== SECTION 1: Create active parent bounty and child bounty =====

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
  await scheduleInlineCallWithOriginTreasurer(client, approveBountyTx.method.toHex())

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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOriginTreasurer(client, proposeCuratorTx.method.toHex())

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

  // ===== SECTION 2: Bob adds maxActiveChildBountyCount child bounties in one batch =====

  const maxActiveChildBountyCount = client.api.consts.childBounties.maxActiveChildBountyCount.toNumber()
  // each child bounty has the smallest value the runtime allows, so the parent bounty can fund all of them and
  // one more
  const childBountyValue = client.api.consts.childBounties.childBountyValueMinimum.toBigInt()
  const parentAccount = bountyAccount(client, bountyIndex)
  expect(await getFreeBalance(client, parentAccount)).toBeGreaterThan(
    BigInt(maxActiveChildBountyCount + 1) * childBountyValue,
  )

  const addChildBountiesTx = client.api.tx.utility.batchAll(
    Array.from({ length: maxActiveChildBountyCount }, (_, i) =>
      client.api.tx.childBounties.addChildBounty(bountyIndex, childBountyValue, `Test child bounty ${i}`),
    ),
  )
  await sendTransaction(addChildBountiesTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // every add of the batch emitted its event, with child indices counting up from 0
  const addedChildIndices = (await client.api.query.system.events()).flatMap(({ event }) =>
    client.api.events.childBounties.Added.is(event) ? [event.data.childIndex.toNumber()] : [],
  )
  expect(addedChildIndices).toEqual(Array.from({ length: maxActiveChildBountyCount }, (_, i) => i))

  // the active count is at the limit, the point where the runtime starts rejecting new child bounties, and it is
  // backed by that many child bounties in storage
  const parentChildBountiesCount = await getParentChildBountiesCount(client, bountyIndex)
  expect(parentChildBountiesCount).toBe(maxActiveChildBountyCount)
  expect(await client.api.query.childBounties.childBounties.keys(bountyIndex)).toHaveLength(maxActiveChildBountyCount)
  const parentBountyBalanceAtLimit = await getFreeBalance(client, parentAccount)

  // ===== SECTION 3: Attempt to add one more child bounty =====

  const childBountyDescription = 'Test child bounty'

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    childBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 4: Verify the transaction fails with TooManyChildBounties error and nothing changed =====

  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.childBounties.TooManyChildBounties.is(dispatchError.asModule)).toBeTruthy()

  // ensure the counts, the stored child bounties and the parent bounty's funds are the same as before
  const parentChildBountiesCountAfter = await getParentChildBountiesCount(client, bountyIndex)
  expect(parentChildBountiesCountAfter).toBe(parentChildBountiesCount)
  expect(await getParentTotalChildBountiesCount(client, bountyIndex)).toBe(maxActiveChildBountyCount)
  expect(await client.api.query.childBounties.childBounties.keys(bountyIndex)).toHaveLength(maxActiveChildBountyCount)
  expect(await getFreeBalance(client, parentAccount)).toBe(parentBountyBalanceAtLimit)

  // ===== SECTION 5: Bob closes one child bounty, then adds a child bounty again =====

  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(bountyIndex, 0)
  await sendTransaction(closeChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // closing removed child bounty 0 from storage and freed one slot
  expect(await getChildBounty(client, bountyIndex, 0)).toBeNull()
  expect(await client.api.query.childBounties.childBounties.keys(bountyIndex)).toHaveLength(
    maxActiveChildBountyCount - 1,
  )
  expect(await getParentChildBountiesCount(client, bountyIndex)).toBe(maxActiveChildBountyCount - 1)

  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // the add succeeded. Child indices are never reused, so the new child bounty takes the index after the batch,
  // not the index of the closed one
  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)
  expect(parentIndex).toBe(bountyIndex)
  expect(childIndex).toBe(maxActiveChildBountyCount)
  expect(await getParentChildBountiesCount(client, bountyIndex)).toBe(maxActiveChildBountyCount)
  expect(await client.api.query.childBounties.childBounties.keys(bountyIndex)).toHaveLength(maxActiveChildBountyCount)
  expect(await getParentTotalChildBountiesCount(client, bountyIndex)).toBe(maxActiveChildBountyCount + 1)
}

/**
 * Test: child bounty description larger than `MaximumReasonLength` throws `ReasonTooBig` error
 *
 * This test verifies the `ReasonTooBig` error condition to ensure that:
 * - Child bounty descriptions cannot exceed the allowed maximum length
 * - The system enforces maximum length constraints for child bounty descriptions
 * - Attempts to create descriptions exceeding the limit fail appropriately
 *
 * Test structure:
 * 1. Create active parent bounty
 * 2. Attempt to create child bounty with description larger than `MaximumReasonLength`
 * 3. Verify the transaction fails with `ReasonTooBig` error
 */
export async function childBountyReasonTooBigErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for child bounty creation'

  // ===== SECTION 1: Create active parent bounty =====

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
  await scheduleInlineCallWithOriginTreasurer(client, approveBountyTx.method.toHex())

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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOriginTreasurer(client, proposeCuratorTx.method.toHex())

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

  // ===== SECTION 2: Attempt to create child bounty with description larger than MaximumReasonLength =====

  // Note: The curator (Bob) should create the child bounty, not Alice
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER // Smaller value for child bounty
  const maximumReasonLength = client.api.consts.bounties.maximumReasonLength.toNumber()
  const longChildBountyDescription = 'X'.repeat(maximumReasonLength + 1) // Description larger than `MaximumReasonLength`

  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    longChildBountyDescription,
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 3: Verify the transaction fails with ReasonTooBig error =====

  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.ReasonTooBig.is(dispatchError.asModule)).toBeTruthy()
}

/**
 * Test: proposing curator for invalid child bounty index throws `InvalidIndex` error
 *
 * This test verifies the `InvalidIndex` error condition to ensure that:
 * - Invalid child bounty indexes cannot be used for proposing curators
 * - The system enforces validation for child bounty index references
 * - Attempts to propose curators with invalid indexes fail appropriately
 *
 * Test structure:
 * 1. Create active parent bounty
 * 2. Attempt to propose curator for invalid child bounty index
 * 3. Verify the transaction fails with `InvalidIndex` error
 */
export async function childBountyProposingCuratorForInvalidIndexErrorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])

  await setLastSpendPeriodBlockNumber(client)

  await client.dev.newBlock()

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum
  const bountyValue = bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER // 1000 tokens
  const description = 'Test bounty for assigning and accepting a child bounty curator'

  // ===== SECTION 1: Create active parent bounty and child bounty =====

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
  await scheduleInlineCallWithOriginTreasurer(client, approveBountyTx.method.toHex())

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

  const curatorFee = bountyValueMinimum.toBigInt() * CURATOR_FEE_MULTIPLIER
  // assign curator to the bounty
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOriginTreasurer(client, proposeCuratorTx.method.toHex())

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
  const childBountyValue = bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER
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
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('child bounty added events')

  // Get child bounty indices
  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)
  expect(parentIndex).toBe(bountyIndex)

  // Verify child bounty status is Added
  const childBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(childBounty.status.isAdded).toBe(true)

  // ===== SECTION 2: Attempt to propose curator for invalid child bounty index =====

  const invalidChildIndex = childIndex + 1 // one more than the last child index

  // Propose curator for child bounty
  const childCuratorFee = bountyValueMinimum.toBigInt() * CHILD_CURATOR_FEE_MULTIPLIER
  const proposeChildCuratorTx = client.api.tx.childBounties.proposeCurator(
    parentIndex,
    invalidChildIndex,
    testAccounts.charlie.address,
    childCuratorFee,
  )
  await sendTransaction(proposeChildCuratorTx.signAsync(testAccounts.bob))

  await client.dev.newBlock()

  // ===== SECTION 3: Verify the transaction fails with InvalidIndex error =====

  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.bounties.InvalidIndex.is(dispatchError.asModule)).toBeTruthy()
}

/**
 * While the parent bounty has no active curator, child bounty calls fail with `ParentBountyNotActive`, except
 * that `RejectOrigin` can still unassign a child curator.
 *
 * A parent bounty stops being active when its curator is unassigned. The child bounties stay in storage. Closing
 * one needs an active parent even for `RejectOrigin`, and so does an unassign by an account that is not the child
 * curator. An unassign by `RejectOrigin` does not look at the parent, so governance can still remove and slash a
 * child curator. `Treasurer` is the `RejectOrigin` used here, and its calls are injected into the scheduler's
 * agenda.
 *
 * 1. Create an active parent bounty (Bob) with an active child bounty (Charlie)
 * 2. Treasurer unassigns the parent curator, which leaves the parent bounty funded and without a curator
 * 3. Treasurer tries to close the child bounty
 * 4. Verify the dispatch result is ParentBountyNotActive and nothing changed
 * 5. Eve, who has no role, tries to unassign the child curator
 * 6. Verify the extrinsic fails with ParentBountyNotActive and nothing changed
 * 7. Treasurer unassigns the child curator
 * 8. Verify the call was dispatched, Charlie's deposit was slashed to the chain's slash sink, and the child bounty
 *    is back to Added
 */
export async function childBountyInactiveParentTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig) {
  // 1. Active parent bounty and active child bounty
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'eve'])
  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Parent bounty that loses its curator',
    testAccounts.bob,
  )
  const { parentIndex, childIndex } = await createActiveChildBountyWithCurator(
    client,
    bountyIndex,
    testAccounts.bob,
    'Child bounty of a parent without a curator',
    testAccounts.charlie,
  )
  const curatorDeposit = (await getChildBounty(client, parentIndex, childIndex)).curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)

  // 2. Treasurer unassigns the parent curator
  const unassignParentCuratorTx = client.api.tx.bounties.unassignCurator(parentIndex)
  await scheduleInlineCallWithOriginTreasurer(client, unassignParentCuratorTx.method.toHex())
  await client.dev.newBlock()

  const parentUnassignDispatched = await getDispatchedEvents(client)
  expect(parentUnassignDispatched).toHaveLength(1)
  expect(parentUnassignDispatched[0].result.isOk).toBe(true)
  const inactiveParentBounty = await getBounty(client, parentIndex)
  expect(inactiveParentBounty.status.isFunded).toBe(true)

  const stateBefore = await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)
  expect(stateBefore.curatorReserved).toBe(curatorDeposit)

  // 3. Treasurer tries to close the child bounty
  const closeChildBountyTx = client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex)
  await scheduleInlineCallWithOriginTreasurer(client, closeChildBountyTx.method.toHex())
  await client.dev.newBlock()

  // 4. ParentBountyNotActive, nothing changed
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('treasurer close under inactive parent: scheduler dispatched event')
  const closeDispatched = await getDispatchedEvents(client)
  expect(closeDispatched).toHaveLength(1)
  assert(closeDispatched[0].result.isErr)
  const closeError = closeDispatched[0].result.asErr
  assert(closeError.isModule)
  expect(client.api.errors.childBounties.ParentBountyNotActive.is(closeError.asModule)).toBe(true)
  expect(await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)).toEqual(stateBefore)

  // 5. Eve tries to unassign the child curator
  const unassignCuratorTx = client.api.tx.childBounties.unassignCurator(parentIndex, childIndex)
  await sendTransaction(unassignCuratorTx.signAsync(testAccounts.eve))
  await client.dev.newBlock()

  // 6. ParentBountyNotActive, nothing changed
  const failedEvent = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent.event))
  const unassignError = failedEvent.event.data.dispatchError
  assert(unassignError.isModule)
  expect(client.api.errors.childBounties.ParentBountyNotActive.is(unassignError.asModule)).toBe(true)
  expect(await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)).toEqual(stateBefore)

  // 7. Treasurer unassigns the child curator
  await scheduleInlineCallWithOriginTreasurer(client, unassignCuratorTx.method.toHex())
  await client.dev.newBlock()

  // 8. Dispatched, deposit slashed to the sink, back to Added
  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: 'balances', method: 'Slashed' },
    { section: 'treasury', method: 'Deposit' },
  )
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('treasurer unassign under inactive parent: dispatched and slash events')
  const unassignDispatched = await getDispatchedEvents(client)
  expect(unassignDispatched).toHaveLength(1)
  expect(unassignDispatched[0].result.isOk).toBe(true)
  await expectCuratorSlashedToSink(client, testConfig, testAccounts.charlie.address, curatorDeposit)

  const unassignedChildBounty = await getChildBounty(client, parentIndex, childIndex)
  expect(unassignedChildBounty.status.isAdded).toBe(true)
  expect(unassignedChildBounty.curatorDeposit.toBigInt()).toBe(0n)
  const charlieAfter = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfter.data.reserved.toBigInt()).toBe(0n)
}

/**
 *  All failure tests for child bounties
 *
 */
export function allChildBountiesFailureTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(getClient: () => Client<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'All child bounties failure tests',
    children: [
      {
        kind: 'test',
        label: 'create child bounty from non-active parent bounty throws ParentBountyNotActive error',
        testFn: async () => await childBountyParentBountyNotActiveErrorTest(getClient()),
      },
      {
        kind: 'test',
        label:
          'create child bounty with value larger than parent bounty balance throws InsufficientBountyBalance error',
        testFn: async () => await childBountyInsufficientBountyBalanceErrorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'create child bounty with value below minimum throws InvalidValue error',
        testFn: async () => await childBountyInvalidValueErrorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'propose curator with fee >= child bounty value throws InvalidFee error',
        testFn: async () => await childBountyInvalidFeeErrorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'accept curator when child bounty is in Added status throws UnexpectedStatus error',
        testFn: async () => await childBountyUnexpectedStatusErrorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'close child bounty in PendingPayout status throws PendingPayout error',
        testFn: async () => await childBountyPendingPayoutErrorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'non-curator trying to create child bounty throws RequireCurator error',
        testFn: async () => await childBountyRequireCuratorErrorTest(getClient()),
      },
      {
        kind: 'test',
        label:
          'parent already has MaxActiveChildBountyCount child bounties, trying to create a new one throws TooManyChildBounties error',
        testFn: async () => await childBountyTooManyChildBountiesErrorTest(getClient()),
      },
      // ReasonTooBig
      {
        kind: 'test',
        label: 'child bounty description larger than MaximumReasonLength throws ReasonTooBig error',
        testFn: async () => await childBountyReasonTooBigErrorTest(getClient()),
      },
      // InvalidIndex
      {
        kind: 'test',
        label: 'proposing curator for invalid child bounty index throws InvalidIndex error',
        testFn: async () => await childBountyProposingCuratorForInvalidIndexErrorTest(getClient()),
      },
      // ParentBountyNotActive on a child bounty that already exists
      {
        kind: 'test',
        label: 'calls on a child of an inactive parent bounty - ParentBountyNotActive unless RejectOrigin unassigns',
        testFn: async () => await childBountyInactiveParentTest(getClient(), testConfig),
      },
    ],
  } as RootTestTree
}

/**
 * An account with no role on the parent or child bounty cannot make any curator-gated call.
 *
 * Each of these calls names who may send it: the parent curator, the child curator, or both. Sending them all from
 * an unrelated account, in one `utility.forceBatch`, checks every gate, and that a rejected call leaves no trace.
 * `claim_child_bounty` is open to any signed account and `add_child_bounty` has its own test, so neither is here.
 *
 * 1. Build a parent bounty with one child bounty in each status
 * 2. Eve, who has no role, batches one call per gate
 * 3. Verify the batch reports six failed calls
 * 4. Verify each failure is the error of its gate
 * 5. Verify no child bounty, counter, fee total or deposit changed
 */
export async function childBountyNoRoleOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // 1. One child bounty per status
  const { parentIndex, added, curatorProposed, active, pendingPayout, childFee } =
    await createChildBountiesInEveryStatus(client)
  const stateBefore = await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)

  // 2. Eve batches one call per gate
  const batchTx = client.api.tx.utility.forceBatch([
    // Only the parent curator proposes a child curator
    client.api.tx.childBounties.proposeCurator(parentIndex, added, testAccounts.eve.address, childFee),
    // Only the proposed curator accepts
    client.api.tx.childBounties.acceptCurator(parentIndex, curatorProposed),
    // Only the proposed curator or the parent curator withdraws a proposal
    client.api.tx.childBounties.unassignCurator(parentIndex, curatorProposed),
    // Only the child curator or the parent curator awards
    client.api.tx.childBounties.awardChildBounty(parentIndex, active, testAccounts.eve.address),
    // Only the parent curator closes
    client.api.tx.childBounties.closeChildBounty(parentIndex, active),
    // Only the parent curator unassigns once the child bounty is awarded
    client.api.tx.childBounties.unassignCurator(parentIndex, pendingPayout),
  ])
  const batchEvents = await sendTransaction(batchTx.signAsync(testAccounts.eve))
  await client.dev.newBlock()

  // 3. Six failed calls
  await checkEvents(batchEvents, 'utility').toMatchSnapshot('no role: utility batch events')
  const errors = await getItemFailedErrors(client)
  expect(errors).toHaveLength(6)
  const [proposeError, acceptError, unassignProposedError, awardError, closeError, unassignAwardedError] = errors

  // 4. The curator checks answer RequireCurator, the origin checks answer BadOrigin
  assert(proposeError.isModule)
  expect(client.api.errors.bounties.RequireCurator.is(proposeError.asModule)).toBe(true)
  assert(acceptError.isModule)
  expect(client.api.errors.bounties.RequireCurator.is(acceptError.asModule)).toBe(true)
  expect(unassignProposedError.isBadOrigin).toBe(true)
  assert(awardError.isModule)
  expect(client.api.errors.bounties.RequireCurator.is(awardError.asModule)).toBe(true)
  expect(closeError.isBadOrigin).toBe(true)
  expect(unassignAwardedError.isBadOrigin).toBe(true)

  // 5. Nothing changed
  expect(await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)).toEqual(stateBefore)
}

/**
 * A child curator cannot make the calls reserved for the parent curator, and cannot walk away from an awarded
 * child bounty.
 *
 * Charlie curates an active and an awarded child bounty. That role lets Charlie award, and unassign themselves
 * while the child bounty is active. It does not let Charlie propose curators or close child bounties, which
 * belong to the parent curator, nor unassign themselves after awarding, which would be a way to escape the slash
 * the parent curator can apply to a bad award.
 *
 * 1. Build a parent bounty with one child bounty in each status
 * 2. Charlie, the child curator, batches the three calls
 * 3. Verify the batch reports three failed calls
 * 4. Verify each failure is the error of its gate
 * 5. Verify no child bounty, counter, fee total or deposit changed
 */
export async function childBountyChildCuratorOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // 1. One child bounty per status
  const { parentIndex, added, active, pendingPayout, childFee } = await createChildBountiesInEveryStatus(client)
  const stateBefore = await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)

  // 2. Charlie batches the three calls
  const batchTx = client.api.tx.utility.forceBatch([
    // Only the parent curator proposes a child curator
    client.api.tx.childBounties.proposeCurator(parentIndex, added, testAccounts.charlie.address, childFee),
    // Only the parent curator closes, even a child bounty Charlie curates
    client.api.tx.childBounties.closeChildBounty(parentIndex, active),
    // Only the parent curator unassigns once the child bounty is awarded
    client.api.tx.childBounties.unassignCurator(parentIndex, pendingPayout),
  ])
  const batchEvents = await sendTransaction(batchTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 3. Three failed calls
  await checkEvents(batchEvents, 'utility').toMatchSnapshot('child curator: utility batch events')
  const errors = await getItemFailedErrors(client)
  expect(errors).toHaveLength(3)
  const [proposeError, closeError, unassignAwardedError] = errors

  // 4. The curator check answers RequireCurator, the origin checks answer BadOrigin
  assert(proposeError.isModule)
  expect(client.api.errors.bounties.RequireCurator.is(proposeError.asModule)).toBe(true)
  expect(closeError.isBadOrigin).toBe(true)
  expect(unassignAwardedError.isBadOrigin).toBe(true)

  // 5. Nothing changed
  expect(await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)).toEqual(stateBefore)
}

/**
 * Root cannot make the calls that only accept a signed origin.
 *
 * Five of the seven calls require a signed origin and have no privileged path: adding, proposing a curator,
 * accepting, awarding and claiming. Root is the strongest origin of the runtime, so its rejection shows these calls
 * have no governance override. The calls are injected into the scheduler's agenda with a Root origin, so each
 * outcome is the `result` of a `scheduler.Dispatched` event.
 *
 * 1. Build a parent bounty with one child bounty in each status
 * 2. Inject the five calls with a Root origin, each against a child bounty in the status the call expects
 * 3. Verify the scheduler dispatched all five
 * 4. Verify every result is BadOrigin
 * 5. Verify no child bounty, counter, fee total or deposit changed
 */
export async function childBountyRootOnSignedCallsOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // 1. One child bounty per status
  const { parentIndex, added, curatorProposed, active, pendingPayout, childValue, childFee } =
    await createChildBountiesInEveryStatus(client)
  const stateBefore = await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)

  // 2. Inject the five calls as Root
  const calls = [
    client.api.tx.childBounties.addChildBounty(parentIndex, childValue, 'Child bounty added by Root'),
    client.api.tx.childBounties.proposeCurator(parentIndex, added, testAccounts.eve.address, childFee),
    client.api.tx.childBounties.acceptCurator(parentIndex, curatorProposed),
    client.api.tx.childBounties.awardChildBounty(parentIndex, active, testAccounts.dave.address),
    client.api.tx.childBounties.claimChildBounty(parentIndex, pendingPayout),
  ]
  await scheduleInlineCallListWithSameOrigin(
    client,
    calls.map((call) => call.method.toHex()),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. All five were dispatched
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('root on signed calls: scheduler dispatched events')
  const dispatched = await getDispatchedEvents(client)
  expect(dispatched).toHaveLength(calls.length)

  // 4. Every result is BadOrigin
  for (const [position, { task, result }] of dispatched.entries()) {
    expect(task[1].toNumber()).toBe(position)
    assert(result.isErr)
    expect(result.asErr.isBadOrigin).toBe(true)
  }

  // 5. Nothing changed
  expect(await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)).toEqual(stateBefore)
}

/**
 * A treasury Spender track cannot unassign a child curator or close a child bounty.
 *
 * `unassign_curator` and `close_child_bounty` accept the treasury's `RejectOrigin` in place of a signed origin.
 * On these runtimes that is Root or the `Treasurer` track. `BigSpender` is the largest treasury Spender track that
 * is neither, so its rejection shows that the power to approve spends does not include the power to slash a child
 * curator or cancel a child bounty.
 *
 * 1. Build a parent bounty with one child bounty in each status
 * 2. Inject `unassign_curator` and `close_child_bounty` on the active child bounty with a `BigSpender` origin
 * 3. Verify the scheduler dispatched both
 * 4. Verify both results are BadOrigin
 * 5. Verify the child bounty is still active and its curator deposit still reserved
 */
export async function childBountySpenderOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // 1. One child bounty per status
  const { parentIndex, active } = await createChildBountiesInEveryStatus(client)
  const stateBefore = await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)

  // 2. Inject both calls as BigSpender
  const calls = [
    client.api.tx.childBounties.unassignCurator(parentIndex, active),
    client.api.tx.childBounties.closeChildBounty(parentIndex, active),
  ]
  await scheduleInlineCallListWithSameOrigin(
    client,
    calls.map((call) => call.method.toHex()),
    { Origins: 'BigSpender' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Both were dispatched
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('spender track: scheduler dispatched events')
  const dispatched = await getDispatchedEvents(client)
  expect(dispatched).toHaveLength(calls.length)

  // 4. Both results are BadOrigin
  for (const [position, { task, result }] of dispatched.entries()) {
    expect(task[1].toNumber()).toBe(position)
    assert(result.isErr)
    expect(result.asErr.isBadOrigin).toBe(true)
  }

  // 5. Still active, deposit still reserved
  const stateAfter = await getChildBountiesState(client, parentIndex, testAccounts.charlie.address)
  expect(stateAfter).toEqual(stateBefore)
  const activeChild = await getChildBounty(client, parentIndex, active)
  expect(activeChild.status.isActive).toBe(true)
}

/**
 * All rejected-origin tests for child bounties
 */
export function allChildBountiesOriginTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'All child bounties origin tests',
    children: [
      {
        kind: 'test',
        label: 'curator-gated calls from an account with no role - RequireCurator or BadOrigin',
        testFn: async () => await childBountyNoRoleOriginTest(getClient()),
      },
      {
        kind: 'test',
        label: 'parent-curator calls from the child curator - RequireCurator or BadOrigin',
        testFn: async () => await childBountyChildCuratorOriginTest(getClient()),
      },
      {
        kind: 'test',
        label: 'signed-only calls from Root - BadOrigin',
        testFn: async () => await childBountyRootOnSignedCallsOriginTest(getClient()),
      },
      {
        kind: 'test',
        label: 'unassign and close from a Spender track - BadOrigin',
        testFn: async () => await childBountySpenderOriginTest(getClient()),
      },
    ],
  } as RootTestTree
}

/// -------
/// Locked funds in a child bounty's account
/// -------

/**
 * First runtime spec version of the Polkadot and Kusama Asset Hubs in which a child bounty's payout
 * and refund are sized from the balance its account can transfer.
 */
const SPENDABLE_PAYOUT_SPEC_VERSION = 2_006_000

/** How far in the future, in block provider blocks, a vesting schedule starts so that none of it unlocks during a test. */
const VESTING_START_DELAY = 10_000_000

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
 * Test: `claim_child_bounty` pays out what the child bounty's account can transfer and leaves
 * locked funds behind.
 *
 * Anyone can lock funds in a child bounty's account with a vested transfer. A payout sized from the
 * whole free balance would then ask for more than the account can move, and the beneficiary would
 * get nothing while the child bounty is removed. The payout must be the spendable balance less the
 * child curator's fee.
 *
 * 1. A parent bounty becomes active with Bob as curator.
 * 2. Bob adds a child bounty, Charlie becomes its curator and awards it to Dave.
 * 3. Alice makes a vested transfer to the child bounty's account, with a schedule that has not started.
 * 4. Alice calls `claim_child_bounty`.
 * 5. `Claimed` reports the child bounty's value less the child curator's fee as the payout.
 * 6. Dave received exactly the payout, and Charlie received his fee and his deposit back.
 * 7. The child bounty is gone, and the locked amount is still in its account, still frozen.
 */
async function claimChildBountyWithLockedFundsTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie', 'dave'])
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const minVestedTransfer = client.api.consts.vesting.minVestedTransfer.toBigInt()
  const lockedAmount = (minVestedTransfer > existentialDeposit ? minVestedTransfer : existentialDeposit) * 10n
  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const childBountyValue = bountyValueMinimum * CHILD_BOUNTY_MULTIPLIER
  const childCuratorFee = bountyValueMinimum * CHILD_CURATOR_FEE_MULTIPLIER

  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  // 1. A parent bounty becomes active with Bob as curator.
  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Parent of a child bounty with locked funds',
    testAccounts.bob,
  )

  // 2. Bob adds a child bounty, Charlie becomes its curator and awards it to Dave.
  const { parentIndex, childIndex } = await createActiveChildBountyWithCurator(
    client,
    bountyIndex,
    testAccounts.bob,
    'Child bounty with locked funds',
    testAccounts.charlie,
  )
  const awardChildBountyTx = client.api.tx.childBounties.awardChildBounty(
    parentIndex,
    childIndex,
    testAccounts.dave.address,
  )
  await sendTransaction(awardChildBountyTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()
  expect((await getChildBounty(client, parentIndex, childIndex)).status.isPendingPayout).toBe(true)

  const account = childBountyAccount(client, parentIndex, childIndex)
  expect(await getFreeFunds(client, account)).toBe(childBountyValue)

  // 3. Alice makes a vested transfer to the child bounty's account, with a schedule that has not started.
  const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const vestedTransferTx = client.api.tx.vesting.vestedTransfer(account, {
    locked: lockedAmount,
    perBlock: lockedAmount,
    startingBlock: currentBlock + VESTING_START_DELAY,
  })
  await sendTransaction(vestedTransferTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  const accountBefore = await client.api.query.system.account(account)
  expect(accountBefore.data.free.toBigInt()).toBe(childBountyValue + lockedAmount)
  expect(accountBefore.data.frozen.toBigInt()).toBe(lockedAmount)

  // The payout is already unlocked, so the claim below is not rejected as premature.
  const unlockAt = (await getChildBounty(client, parentIndex, childIndex)).status.asPendingPayout.unlockAt.toNumber()
  expect(unlockAt).toBeLessThanOrEqual(
    await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider),
  )

  const daveBefore = await getFreeFunds(client, testAccounts.dave.address)
  const charlieBefore = await client.api.query.system.account(testAccounts.charlie.address)

  // 4. Alice calls `claim_child_bounty`.
  const claimEvents = await sendTransaction(
    client.api.tx.childBounties.claimChildBounty(parentIndex, childIndex).signAsync(testAccounts.alice),
  )
  await client.dev.newBlock()

  // 5. `Claimed` reports the child bounty's value less the child curator's fee as the payout.
  await checkEvents(claimEvents, { section: 'childBounties', method: 'Claimed' })
    .redact({ redactKeys: /^(index|childIndex)$/ })
    .toMatchSnapshot('child bounty claimed events')

  const payout = childBountyValue - childCuratorFee
  const records = await client.api.query.system.events()
  const claimed = records.filter(({ event }) => client.api.events.childBounties.Claimed.is(event))
  expect(claimed).toHaveLength(1)
  assert(client.api.events.childBounties.Claimed.is(claimed[0].event))
  expect(claimed[0].event.data.index.toNumber()).toBe(parentIndex)
  expect(claimed[0].event.data.childIndex.toNumber()).toBe(childIndex)
  expect(claimed[0].event.data.payout.toBigInt()).toBe(payout)
  expect(claimed[0].event.data.beneficiary.toString()).toBe(
    encodeAddress(testAccounts.dave.address, client.config.properties.addressEncoding),
  )

  // 6. Dave received exactly the payout, and Charlie received his fee and his deposit back.
  expect((await getFreeFunds(client, testAccounts.dave.address)) - daveBefore).toBe(payout)
  const charlieAfter = await client.api.query.system.account(testAccounts.charlie.address)
  expect(charlieAfter.data.reserved.toBigInt()).toBe(0n)
  expect(charlieAfter.data.free.toBigInt()).toBe(
    charlieBefore.data.free.toBigInt() + charlieBefore.data.reserved.toBigInt() + childCuratorFee,
  )

  // 7. The child bounty is gone, and the locked amount is still in its account, still frozen.
  expect(await getChildBounty(client, parentIndex, childIndex)).toBeNull()
  const accountAfter = await client.api.query.system.account(account)
  expect(accountAfter.data.free.toBigInt()).toBe(lockedAmount)
  expect(accountAfter.data.frozen.toBigInt()).toBe(lockedAmount)
}

/**
 * Test: `close_child_bounty` returns what the child bounty's account can transfer to the parent
 * bounty and leaves locked funds behind.
 *
 * Closing a child bounty refunds its parent. A refund sized from the whole free balance would ask
 * for more than an account with locked funds can move, and the parent would get nothing back while
 * the child bounty is removed. The refund must be the spendable balance.
 *
 * 1. A parent bounty becomes active with Bob as curator.
 * 2. Bob adds a child bounty, which moves its value out of the parent bounty's account.
 * 3. Alice makes a vested transfer to the child bounty's account, with a schedule that has not started.
 * 4. Bob calls `close_child_bounty`.
 * 5. `Canceled` is emitted and the parent bounty's account gets the child bounty's value back.
 * 6. The child bounty is gone, and the locked amount is still in its account, still frozen.
 */
async function closeChildBountyWithLockedFundsTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const minVestedTransfer = client.api.consts.vesting.minVestedTransfer.toBigInt()
  const lockedAmount = (minVestedTransfer > existentialDeposit ? minVestedTransfer : existentialDeposit) * 10n
  const childBountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * CHILD_BOUNTY_MULTIPLIER

  await setLastSpendPeriodBlockNumber(client)
  await client.dev.newBlock()

  // 1. A parent bounty becomes active with Bob as curator.
  const bountyIndex = await createActiveParentBountyWithCurator(
    client,
    'Parent of a closed child bounty with locked funds',
    testAccounts.bob,
  )

  // 2. Bob adds a child bounty, which moves its value out of the parent bounty's account.
  const addChildBountyTx = client.api.tx.childBounties.addChildBounty(
    bountyIndex,
    childBountyValue,
    'Child bounty closed with locked funds',
  )
  await sendTransaction(addChildBountyTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()
  const { parentIndex, childIndex } = await getChildBountyIndexFromEvent(client)
  expect((await getChildBounty(client, parentIndex, childIndex)).status.isAdded).toBe(true)

  const account = childBountyAccount(client, parentIndex, childIndex)
  const parentAccount = bountyAccount(client, parentIndex)
  expect(await getFreeFunds(client, account)).toBe(childBountyValue)

  // 3. Alice makes a vested transfer to the child bounty's account, with a schedule that has not started.
  const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const vestedTransferTx = client.api.tx.vesting.vestedTransfer(account, {
    locked: lockedAmount,
    perBlock: lockedAmount,
    startingBlock: currentBlock + VESTING_START_DELAY,
  })
  await sendTransaction(vestedTransferTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  const accountBefore = await client.api.query.system.account(account)
  expect(accountBefore.data.free.toBigInt()).toBe(childBountyValue + lockedAmount)
  expect(accountBefore.data.frozen.toBigInt()).toBe(lockedAmount)
  const parentBefore = await getFreeFunds(client, parentAccount)

  // 4. Bob calls `close_child_bounty`.
  const closeEvents = await sendTransaction(
    client.api.tx.childBounties.closeChildBounty(parentIndex, childIndex).signAsync(testAccounts.bob),
  )
  await client.dev.newBlock()

  // 5. `Canceled` is emitted and the parent bounty's account gets the child bounty's value back.
  await checkEvents(closeEvents, { section: 'childBounties', method: 'Canceled' })
    .redact({ redactKeys: /^(index|childIndex)$/ })
    .toMatchSnapshot('child bounty canceled events')

  const records = await client.api.query.system.events()
  const canceled = records.filter(({ event }) => client.api.events.childBounties.Canceled.is(event))
  expect(canceled).toHaveLength(1)
  assert(client.api.events.childBounties.Canceled.is(canceled[0].event))
  expect(canceled[0].event.data.index.toNumber()).toBe(parentIndex)
  expect(canceled[0].event.data.childIndex.toNumber()).toBe(childIndex)
  expect((await getFreeFunds(client, parentAccount)) - parentBefore).toBe(childBountyValue)

  // 6. The child bounty is gone, and the locked amount is still in its account, still frozen.
  expect(await getChildBounty(client, parentIndex, childIndex)).toBeNull()
  expect(await getParentChildBountiesCount(client, parentIndex)).toBe(0)
  const accountAfter = await client.api.query.system.account(account)
  expect(accountAfter.data.free.toBigInt()).toBe(lockedAmount)
  expect(accountAfter.data.frozen.toBigInt()).toBe(lockedAmount)
}

/**
 * Tests of payouts and refunds from a child bounty's account that holds locked funds. Each one is
 * skipped on a runtime that sizes them from the whole free balance.
 */
export function childBountyLockedFundsTests(getClient: () => Client<any, any>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Locked funds in a child bounty account',
    children: [
      {
        kind: 'test',
        label: 'claim_child_bounty - pays out the spendable balance and leaves locked funds behind',
        testFn: withSpendablePayouts(getClient, claimChildBountyWithLockedFundsTest),
      },
      {
        kind: 'test',
        label: 'close_child_bounty - refunds the spendable balance and leaves locked funds behind',
        testFn: withSpendablePayouts(getClient, closeChildBountyWithLockedFundsTest),
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: ChildBountiesTestConfig): RootTestTree {
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
      allChildBountiesSuccessTests(() => client, testConfig),
      allChildBountiesFailureTests(() => client, testConfig),
      allChildBountiesOriginTests(() => client),
      childBountyLockedFundsTests(() => client),
    ],
  }
}
