import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { EventRecord } from '@polkadot/types/interfaces'
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import type { HexString } from '@polkadot/util/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { match } from 'ts-pattern'
import {
  blockProviderOffset,
  checkEvents,
  checkSystemEvents,
  getBlockNumber,
  scheduleInlineCallListWithSameOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Config
/// -------

/**
 * Scenario parameters for the bounties suite.
 *
 * These are runtime facts that metadata does not expose: where slashed funds go, and the spend limits of the
 * governance origins that may approve bounties.
 */
export interface BountiesTestConfig extends TestConfig {
  /**
   * Where the runtime's `pallet_bounties::Config::OnSlash` sends slashed proposer bonds and curator deposits.
   *
   * - `treasury`: the treasury pot. `pallet_treasury` emits `treasury.Deposit` for each slash.
   * - `dapStaging`: the DAP staging account, through `pallet_dap::DapLegacyAdapter`. No treasury event is emitted.
   */
  slashDestination: 'treasury' | 'dapStaging'
  /** Spend limit of the `SmallTipper` origin, the lowest `Spender` track, in the chain's smallest unit. */
  smallTipperSpendLimit: bigint
  /** Spend limit of the `Treasurer` origin, the highest `Spender` track, in the chain's smallest unit. */
  treasurerSpendLimit: bigint
  /** Id of USDT in the local `Assets` pallet. USDT is one of the assets the runtime sweeps out of a closed bounty. */
  usdtAssetId: number
}

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

/**
 * Account id of a `PalletId` sub-account, built the way `into_sub_account_truncating` builds it: the bytes `modl`,
 * the 8-byte pallet id, the SCALE encoding of the seed, then zero padding up to 32 bytes.
 */
function palletSubAccount(palletId: Uint8Array, encodedSeed: Uint8Array): HexString {
  const raw = u8aConcat(stringToU8a('modl'), palletId, encodedSeed)
  return u8aToHex(u8aConcat(raw, new Uint8Array(32 - raw.length)))
}

/**
 * The DAP staging account, where `pallet_dap::DapLegacyAdapter` puts slashed funds.
 *
 * `sp_dap` derives it from the fixed pallet id `dap/buff` and the seed `b"staging"`. `pallet_dap`'s `on_idle` moves
 * everything above the existential deposit into the DAP buffer in the same block, so its balance does not show a
 * slash once the block is built; the `balances.Deposit` event does.
 */
function dapStagingAccount(): HexString {
  return palletSubAccount(stringToU8a('dap/buff'), compactAddLength(stringToU8a('staging')))
}

/**
 * The account that holds a bounty's funds: the treasury pallet id with the seed `("bt", bountyIndex)`.
 */
function bountyAccount(client: Client<any, any>, bountyIndex: number): HexString {
  const seed = u8aConcat(compactAddLength(stringToU8a('bt')), client.api.createType('u32', bountyIndex).toU8a())
  return palletSubAccount(client.api.consts.treasury.palletId.toU8a(), seed)
}

/**
 * Check the pallet's `do_try_state` invariants: `BountyCount` is at least the number of stored bounties and of
 * stored descriptions, and every stored bounty has a description.
 */
async function checkBountiesTryState(client: Client<any, any>) {
  const bountyCount = await getBountyCount(client)
  const bountyKeys = await client.api.query.bounties.bounties.keys()
  const descriptionKeys = await client.api.query.bounties.bountyDescriptions.keys()
  expect(bountyCount).toBeGreaterThanOrEqual(bountyKeys.length)
  expect(bountyCount).toBeGreaterThanOrEqual(descriptionKeys.length)
  expect(descriptionKeys.length).toBe(bountyKeys.length)
}

/**
 * The `Dispatched` results the scheduler recorded in the head block, in dispatch order.
 */
async function schedulerDispatchedResults(client: Client<any, any>): Promise<any[]> {
  const events = await client.api.query.system.events()
  return events
    .filter(({ event }) => client.api.events.scheduler.Dispatched.is(event))
    .map(({ event }) => {
      assert(client.api.events.scheduler.Dispatched.is(event))
      return event.data.result
    })
}

/**
 * Dispatch a setup call from `origin` through the scheduler in the next block, and assert it succeeded.
 *
 * Only for preconditions. A test of the call itself schedules it and reads the `Dispatched` result in its own body.
 * The scheduler drops inline calls above 128 bytes, so the size is checked first.
 */
async function dispatchSetupCall(client: Client<any, any>, call: SubmittableExtrinsic<'promise'>, origin: any) {
  expect(call.method.encodedLength).toBeLessThanOrEqual(128)
  await scheduleInlineCallWithOrigin(
    client,
    call.method.toHex(),
    origin,
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isOk, `setup call ${call.method.section}.${call.method.method} failed: ${results[0].toString()}`)
}

/**
 * Propose a bounty from `proposer`, and return its index from the `BountyProposed` event.
 */
async function proposeBounty(
  client: Client<any, any>,
  proposer: KeyringPair,
  value: bigint,
  description: string,
): Promise<number> {
  await sendTransaction(client.api.tx.bounties.proposeBounty(value, description).signAsync(proposer))
  await client.dev.newBlock()
  return await getBountyIndexFromEvent(client)
}

/**
 * Make the next block start a treasury spend period, so `spend_funds` funds the approved bounties.
 *
 * `Treasury.lastSpendPeriod` is set one `SpendPeriod` behind the current block of the treasury's block provider. The
 * next block's `on_initialize` then sees at least one full period passed, whichever relay block it reads.
 */
async function startSpendPeriodNextBlock(client: Client<any, any>) {
  const spendPeriod = client.api.consts.treasury.spendPeriod.toNumber()
  const now = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  await client.dev.setStorage({ Treasury: { lastSpendPeriod: now - spendPeriod } })
  expect((await client.api.query.treasury.lastSpendPeriod()).unwrap().toNumber()).toBe(now - spendPeriod)
}

/**
 * Create a `Funded` bounty: Alice proposes it, `Treasurer` approves it, and the next spend period funds it.
 */
async function createFundedBounty(client: Client<any, any>, value: bigint, description: string): Promise<number> {
  const bountyIndex = await proposeBounty(client, testAccounts.alice, value, description)
  await dispatchSetupCall(client, client.api.tx.bounties.approveBounty(bountyIndex), { Origins: 'Treasurer' })

  await startSpendPeriodNextBlock(client)
  await client.dev.newBlock()

  const bounty = await getBounty(client, bountyIndex)
  assert(bounty?.status.isFunded, `bounty ${bountyIndex} was not funded`)
  return bountyIndex
}

/**
 * Create an `Active` bounty: a funded bounty, `Treasurer` proposes `curator` with `fee`, and the curator accepts.
 */
async function createActiveBounty(
  client: Client<any, any>,
  value: bigint,
  fee: bigint,
  curator: KeyringPair,
  description: string,
): Promise<number> {
  const bountyIndex = await createFundedBounty(client, value, description)
  await dispatchSetupCall(client, client.api.tx.bounties.proposeCurator(bountyIndex, curator.address, fee), {
    Origins: 'Treasurer',
  })

  await sendTransaction(client.api.tx.bounties.acceptCurator(bountyIndex).signAsync(curator))
  await client.dev.newBlock()

  const bounty = await getBounty(client, bountyIndex)
  assert(bounty?.status.isActive, `bounty ${bountyIndex} did not become active`)
  return bountyIndex
}

/**
 * Free balance of the treasury pot.
 */
async function getTreasuryPotFree(client: Client<any, any>): Promise<bigint> {
  const pot = await client.api.query.system.account(client.api.consts.treasury.potAccount)
  return pot.data.free.toBigInt()
}

/**
 * Verify that `amount`, slashed in the head block, reached the runtime's `OnSlash` destination and nowhere else.
 *
 * - `treasury`: one `treasury.Deposit { value: amount }`, and the pot grew by exactly `amount`.
 * - `dapStaging`: one `balances.Deposit { who: <DAP staging>, amount }`, no `treasury.Deposit`, and the pot did not
 *   move. Transaction fees also land in the DAP staging account on this runtime, so the slash is found by account
 *   and amount.
 *
 * @param potFreeBefore The treasury pot's free balance before the head block.
 */
async function checkSlashDestination(
  client: Client<any, any>,
  testConfig: BountiesTestConfig,
  amount: bigint,
  potFreeBefore: bigint,
  snapshotPrefix: string,
) {
  const events = await client.api.query.system.events()
  const treasuryDeposits = events.filter(({ event }) => client.api.events.treasury.Deposit.is(event))
  const potFreeAfter = await getTreasuryPotFree(client)

  await match(testConfig.slashDestination)
    .with('treasury', async () => {
      await checkSystemEvents(client, { section: 'treasury', method: 'Deposit' }).toMatchSnapshot(
        `${snapshotPrefix}: treasury deposit`,
      )
      expect(treasuryDeposits).toHaveLength(1)
      assert(client.api.events.treasury.Deposit.is(treasuryDeposits[0].event))
      expect(treasuryDeposits[0].event.data.value.toBigInt()).toBe(amount)
      expect(potFreeAfter - potFreeBefore).toBe(amount)
    })
    .with('dapStaging', async () => {
      const staging = dapStagingAccount()
      const stagingDeposits = events.filter(({ event }) => {
        if (!client.api.events.balances.Deposit.is(event)) return false
        return event.data.who.toHex() === staging && event.data.amount.toBigInt() === amount
      })
      await checkSystemEvents(client, { section: 'balances', method: 'Deposit' }).toMatchSnapshot(
        `${snapshotPrefix}: balance deposits`,
      )
      expect(stagingDeposits).toHaveLength(1)
      expect(treasuryDeposits).toHaveLength(0)
      expect(potFreeAfter).toBe(potFreeBefore)
    })
    .exhaustive()
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
 * - Verifying the proposer's bond is returned and the bounty account holds exactly the bounty value
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

  const bond = bountyFromStorage.bond.toBigInt()
  const aliceReservedBeforeFunding = (await client.api.query.system.account(testAccounts.alice.address)).data.reserved

  await client.dev.newBlock()
  // This is the spendPeriodBlock i.e bounty will be funded in this block

  // verify the BountyBecameActive event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyBecameActive' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty became active events')

  // Funding returns the proposer's bond and credits the bounty account with exactly the bounty value.
  const events = await client.api.query.system.events()
  const becameActive = events.find(
    ({ event }) =>
      client.api.events.bounties.BountyBecameActive.is(event) && event.data.index.toNumber() === bountyIndex,
  )
  expect(becameActive).toBeDefined()
  const aliceReservedAfterFunding = (await client.api.query.system.account(testAccounts.alice.address)).data.reserved
  expect(aliceReservedBeforeFunding.toBigInt() - aliceReservedAfterFunding.toBigInt()).toBe(bond)
  const bountyAccountInfo = await client.api.query.system.account(bountyAccount(client, bountyIndex))
  expect(bountyAccountInfo.data.free.toBigInt()).toBe(bountyValue)

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
 * - Verifying the deposit follows the runtime's multiplier and bounds, and `update_due` is one update period ahead
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

  const bobReservedBefore = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved

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

  // The curator deposit is the fee times `CuratorDepositMultiplier`, clamped to `[CuratorDepositMin,
  // CuratorDepositMax]`, and is reserved from Bob.
  const { curatorDepositMultiplier, curatorDepositMin, curatorDepositMax } = client.api.consts.bounties
  let expectedDeposit = (curatorFee * curatorDepositMultiplier.toBigInt()) / 1_000_000n
  if (curatorDepositMax.isSome) {
    expectedDeposit =
      expectedDeposit < curatorDepositMax.unwrap().toBigInt() ? expectedDeposit : curatorDepositMax.unwrap().toBigInt()
  }
  if (curatorDepositMin.isSome) {
    expectedDeposit =
      expectedDeposit > curatorDepositMin.unwrap().toBigInt() ? expectedDeposit : curatorDepositMin.unwrap().toBigInt()
  }
  expect(bountyStatusAfterCuratorAccepted.curatorDeposit.toBigInt()).toBe(expectedDeposit)
  const bobReservedAfter = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved
  expect(bobReservedAfter.toBigInt() - bobReservedBefore.toBigInt()).toBe(expectedDeposit)

  // The curator must act by `BountyUpdatePeriod` after the relay block the acceptance was dispatched in.
  const acceptedAt = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const updatePeriod = client.api.consts.bounties.bountyUpdatePeriod.toNumber()
  expect(bountyStatusAfterCuratorAccepted.status.asActive.updateDue.toNumber()).toBe(acceptedAt + updatePeriod)
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

  // `unlock_at` is in the treasury's block numbers (relay blocks on Asset Hubs), and each block moves that number by
  // the block provider offset. The claim lands in the next block, so only the blocks still missing are built.
  const offset = blockProviderOffset(
    client.config.properties.schedulerBlockProvider,
    (client.config.properties as any).relayBlocksPerParaBlock,
  )
  const unlockAt = bountyAwarded.status.asPendingPayout.unlockAt.toNumber()
  const claimBlockNumber = (await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)) + offset
  const blocksToWait = Math.max(0, Math.ceil((unlockAt - claimBlockNumber) / offset))
  if (blocksToWait > 0) {
    await client.dev.newBlock({ count: blocksToWait })
  }

  // balances before the claim
  const curatorDeposit = bountyAwarded.curatorDeposit.toBigInt()
  const bountyAccountFree = (await client.api.query.system.account(bountyAccount(client, bountyIndex))).data.free
  expect(bountyAccountFree.toBigInt()).toBe(bountyValue)
  const aliceBefore = await client.api.query.system.account(testAccounts.alice.address)
  const bobBefore = await client.api.query.system.account(testAccounts.bob.address)

  // claim the bounty
  const claimBountyTx = client.api.tx.bounties.claimBounty(bountyIndex)
  const claimBountyEvents = await sendTransaction(claimBountyTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  // verify events
  await checkEvents(claimBountyEvents, { section: 'bounties', method: 'BountyClaimed' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty claimed events')

  // The beneficiary is paid the value minus the curator fee.
  const payout = bountyValue - curatorFee
  const events = await client.api.query.system.events()
  const claimed = events.find(({ event }) => client.api.events.bounties.BountyClaimed.is(event))
  assert(claimed && client.api.events.bounties.BountyClaimed.is(claimed.event))
  expect(claimed.event.data.index.toNumber()).toBe(bountyIndex)
  expect(claimed.event.data.payout.toBigInt()).toBe(payout)
  expect(claimed.event.data.beneficiary.toString()).toBe(
    encodeAddress(testAccounts.alice.address, client.config.properties.addressEncoding),
  )

  // Alice gains the payout less her claim fee; Bob gains the fee and gets his deposit back; the bounty account is
  // emptied.
  const { actualFee: claimFee } = await getFeePaid(client, testAccounts.alice.address)
  const aliceAfter = await client.api.query.system.account(testAccounts.alice.address)
  expect(aliceAfter.data.free.toBigInt() - aliceBefore.data.free.toBigInt()).toBe(payout - claimFee)
  const bobAfter = await client.api.query.system.account(testAccounts.bob.address)
  expect(bobAfter.data.free.toBigInt() - bobBefore.data.free.toBigInt()).toBe(curatorFee + curatorDeposit)
  expect(bobBefore.data.reserved.toBigInt() - bobAfter.data.reserved.toBigInt()).toBe(curatorDeposit)
  expect((await client.api.query.system.account(bountyAccount(client, bountyIndex))).data.free.toBigInt()).toBe(0n)

  // verify that the bounty is removed from the storage
  const bountyFromStorageAfterClaiming = await getBounty(client, bountyIndex)
  expect(bountyFromStorageAfterClaiming).toBeNull()

  // verify that the bounty description is removed from the storage
  const bountyDescriptionFromStorageAfterClaiming = await getBountyDescription(client, bountyIndex)
  expect(bountyDescriptionFromStorageAfterClaiming).toBeNull()

  await checkBountiesTryState(client)
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
 * - Verifying the slashed bond reaches the runtime's `OnSlash` destination, and only there
 * - Confirming the bounty is removed from storage
 * - Checking that `BountyRejected` and `Slashed` events are emitted
 */
export async function bountyClosureProposedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: BountiesTestConfig) {
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
  const bond = proposedBounty.bond.toBigInt()
  expect(bond).toBeGreaterThan(0n)

  const potFreeBefore = await getTreasuryPotFree(client)

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

  const [closeResult] = await schedulerDispatchedResults(client)
  assert(closeResult?.isOk, 'close_bounty was not dispatched successfully')

  // Verify BountyRejected event
  await checkSystemEvents(client, { section: 'bounties', method: 'BountyRejected' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('bounty rejected events')

  // verify the Slash event
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' })
    .redact({ redactKeys: /who/ })
    .toMatchSnapshot('proposer bond slashed event')

  // The rejection carries the whole bond, and exactly that is slashed from the proposer.
  const events = await client.api.query.system.events()
  const rejected = events.find(({ event }) => client.api.events.bounties.BountyRejected.is(event))
  assert(rejected && client.api.events.bounties.BountyRejected.is(rejected.event))
  expect(rejected.event.data.index.toNumber()).toBe(bountyIndex)
  expect(rejected.event.data.bond.toBigInt()).toBe(bond)

  const slashed = encodeAddress(testAccounts.alice.address, client.config.properties.addressEncoding)
  const slashes = events.filter(
    ({ event }) => client.api.events.balances.Slashed.is(event) && event.data.who.toString() === slashed,
  )
  expect(slashes).toHaveLength(1)
  assert(client.api.events.balances.Slashed.is(slashes[0].event))
  expect(slashes[0].event.data.amount.toBigInt()).toBe(bond)

  await checkSlashDestination(client, testConfig, bond, potFreeBefore, 'proposer bond slash destination')

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
  // The whole bounty value returns to the treasury.
  expect(treasuryTransferEventData.amount.toBigInt()).toBe(bountyValue)

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
 * - Checking that `CuratorUnassigned` and `Slashed` events are emitted
 * - Verifying the slashed deposit reaches the runtime's `OnSlash` destination, and only there
 */
export async function unassignCuratorActiveByTreasurerTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: BountiesTestConfig) {
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
  const curatorDeposit = bountyStatusAfterCuratorAccepted.curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  const potFreeBefore = await getTreasuryPotFree(client)

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

  const [unassignResult] = await schedulerDispatchedResults(client)
  assert(unassignResult?.isOk, 'unassign_curator was not dispatched successfully')

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned active by treasurer events')

  // verify the curator slash event as the unassignCurator is called by the treasurer
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' })
    .redact({ redactKeys: /who/ })
    .toMatchSnapshot('curator slash event')

  // The whole curator deposit is slashed from Bob, and arrives at the runtime's slash destination.
  const events = await client.api.query.system.events()
  const slashed = encodeAddress(testAccounts.bob.address, client.config.properties.addressEncoding)
  const slashes = events.filter(
    ({ event }) => client.api.events.balances.Slashed.is(event) && event.data.who.toString() === slashed,
  )
  expect(slashes).toHaveLength(1)
  assert(client.api.events.balances.Slashed.is(slashes[0].event))
  expect(slashes[0].event.data.amount.toBigInt()).toBe(curatorDeposit)

  await checkSlashDestination(client, testConfig, curatorDeposit, potFreeBefore, 'curator deposit slash destination')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)
  expect(bountyAfterUnassign.curatorDeposit.toBigInt()).toBe(0n)

  // Verify curator deposit was slashed
  const curatorBalanceAfter = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceAfter = curatorBalanceAfter.data.reserved.toBigInt()
  expect(curatorReservedBalanceBefore - curatorReservedBalanceAfter).toBe(curatorDeposit)
  expect(curatorBalanceAfter.data.free.toBigInt()).toBe(curatorBalanceBefore.data.free.toBigInt())
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
 * - Verifying the slashed deposit reaches the runtime's `OnSlash` destination, and only there
 * - Checking that appropriate events are emitted
 */
export async function unassignCuratorPendingPayoutTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, testConfig: BountiesTestConfig) {
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
  const curatorDeposit = bountyStatusAfterAwarding.curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)
  const potFreeBefore = await getTreasuryPotFree(client)

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

  const [unassignResult] = await schedulerDispatchedResults(client)
  assert(unassignResult?.isOk, 'unassign_curator was not dispatched successfully')

  // Verify CuratorUnassigned event
  await checkSystemEvents(client, { section: 'bounties', method: 'CuratorUnassigned' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator unassigned pending payout events')

  // verify the curator slash event as the unassignCurator is called by the treasurer
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' })
    .redact({ redactKeys: /who/ })
    .toMatchSnapshot('curator slash event')

  // The whole curator deposit is slashed from Bob, and arrives at the runtime's slash destination.
  const events = await client.api.query.system.events()
  const slashed = encodeAddress(testAccounts.bob.address, client.config.properties.addressEncoding)
  const slashes = events.filter(
    ({ event }) => client.api.events.balances.Slashed.is(event) && event.data.who.toString() === slashed,
  )
  expect(slashes).toHaveLength(1)
  assert(client.api.events.balances.Slashed.is(slashes[0].event))
  expect(slashes[0].event.data.amount.toBigInt()).toBe(curatorDeposit)

  await checkSlashDestination(client, testConfig, curatorDeposit, potFreeBefore, 'curator deposit slash destination')

  // Verify bounty status changed to Funded
  const bountyAfterUnassign = await getBounty(client, bountyIndex)
  expect(bountyAfterUnassign.status.isFunded).toBe(true)
  expect(bountyAfterUnassign.curatorDeposit.toBigInt()).toBe(0n)

  // Verify curator reserved balance was slashed
  const curatorBalanceAfter = await client.api.query.system.account(testAccounts.bob.address)
  const curatorReservedBalanceAfter = curatorBalanceAfter.data.reserved.toBigInt()
  expect(curatorReservedBalanceBefore - curatorReservedBalanceAfter).toBe(curatorDeposit)
  expect(curatorBalanceAfter.data.free.toBigInt()).toBe(curatorBalanceBefore.data.free.toBigInt())
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
>(getClient: () => Client<TCustom, TInitStorages>, testConfig: BountiesTestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'Bounty Closure Tests',
    children: [
      {
        kind: 'test',
        label: 'Bounty closure in proposed state',
        testFn: async () => await bountyClosureProposedTest(getClient(), testConfig),
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
>(getClient: () => Client<TCustom, TInitStorages>, testConfig: BountiesTestConfig): RootTestTree {
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
        testFn: async () => await unassignCuratorActiveByTreasurerTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'Unassign curator in PendingPayout state',
        testFn: async () => await unassignCuratorPendingPayoutTest(getClient(), testConfig),
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
>(getClient: () => Client<TCustom, TInitStorages>, testConfig: BountiesTestConfig): RootTestTree {
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
      bountyFundingTests(getClient),
      bountyApprovalTests(getClient),
      bountyClosureTests(getClient, testConfig),
      allCuratorUnassignTests(getClient, testConfig),
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
    .redact({ redactKeys: /^(index|childIndex)$/ })
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
/// Curator slashing
/// -------

/**
 * Once an `Active` curator's `update_due` has passed, any account may unassign them, and their whole deposit is
 * slashed to the runtime's `OnSlash` destination.
 *
 * This is how anyone can remove a curator who stopped working on a bounty. `BountyUpdatePeriod` is 10 years of relay
 * blocks on these runtimes, so instead of waiting, the test moves `update_due` into the past. That is the state an
 * `Active` bounty reaches when its curator never calls `extend_bounty_expiry`.
 *
 * 1. Create an `Active` bounty with Bob as curator
 * 2. Move the bounty's `update_due` to a relay block that has already passed
 * 3. Charlie, who has no role in the bounty, unassigns the curator
 * 4. Verify `CuratorUnassigned`, and the slash of Bob's whole curator deposit
 * 5. Verify the slashed deposit reached the runtime's slash destination, and only there
 * 6. Verify the bounty is `Funded` again with no curator deposit, and Bob's reserve dropped by exactly the deposit
 */
async function unassignCuratorAfterUpdateDueTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Active bounty with Bob as curator
  const bountyIndex = await createActiveBounty(
    client,
    bountyValue,
    curatorFee,
    testAccounts.bob,
    'Test bounty for unassign after update due',
  )
  const activeBounty = await getBounty(client, bountyIndex)
  const curatorDeposit = activeBounty.curatorDeposit.toBigInt()
  expect(curatorDeposit).toBeGreaterThan(0n)

  // 2. Deadline in the past, in the treasury's block numbers (relay blocks on Asset Hubs)
  const relayNow = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  expect(activeBounty.status.asActive.updateDue.toNumber()).toBeGreaterThan(relayNow)
  const pastUpdateDue = relayNow - 1
  await client.dev.setStorage({
    Bounties: {
      bounties: [
        [
          [bountyIndex],
          {
            ...activeBounty.toJSON(),
            status: { Active: { curator: testAccounts.bob.address, updateDue: pastUpdateDue } },
          },
        ],
      ],
    },
  })
  const expiredBounty = await getBounty(client, bountyIndex)
  expect(expiredBounty.status.asActive.updateDue.toNumber()).toBe(pastUpdateDue)
  expect(expiredBounty.curatorDeposit.toBigInt()).toBe(curatorDeposit)

  const bobBefore = await client.api.query.system.account(testAccounts.bob.address)
  const potFreeBefore = await getTreasuryPotFree(client)

  // 3. Charlie unassigns the curator
  const unassignTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  const unassignEvents = await sendTransaction(unassignTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 4. CuratorUnassigned, and the whole deposit slashed from Bob
  await checkEvents(
    unassignEvents,
    { section: 'bounties', method: 'CuratorUnassigned' },
    { section: 'balances', method: 'Slashed' },
  )
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('public unassign after update due events')

  const events = await client.api.query.system.events()
  const unassigned = events.find(({ event }) => client.api.events.bounties.CuratorUnassigned.is(event))
  assert(unassigned && client.api.events.bounties.CuratorUnassigned.is(unassigned.event))
  expect(unassigned.event.data.bountyId.toNumber()).toBe(bountyIndex)

  const slashed = encodeAddress(testAccounts.bob.address, client.config.properties.addressEncoding)
  const slashes = events.filter(
    ({ event }) => client.api.events.balances.Slashed.is(event) && event.data.who.toString() === slashed,
  )
  expect(slashes).toHaveLength(1)
  assert(client.api.events.balances.Slashed.is(slashes[0].event))
  expect(slashes[0].event.data.amount.toBigInt()).toBe(curatorDeposit)

  // 5. Slash destination
  await checkSlashDestination(client, testConfig, curatorDeposit, potFreeBefore, 'public unassign slash destination')

  // 6. Bounty back to Funded, deposit gone from Bob's reserve, his free balance untouched
  const bountyAfter = await getBounty(client, bountyIndex)
  expect(bountyAfter.status.isFunded).toBe(true)
  expect(bountyAfter.curatorDeposit.toBigInt()).toBe(0n)

  const bobAfter = await client.api.query.system.account(testAccounts.bob.address)
  expect(bobBefore.data.reserved.toBigInt() - bobAfter.data.reserved.toBigInt()).toBe(curatorDeposit)
  expect(bobAfter.data.free.toBigInt()).toBe(bobBefore.data.free.toBigInt())
}

/**
 * Curator slashing tests: an inactive curator removed by any account, and where their deposit goes.
 */
export function curatorSlashingTests(getClient: () => Client<any, any>, testConfig: BountiesTestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'Curator slashing',
    children: [
      {
        kind: 'test',
        label: 'unassign curator by a public account after the update deadline - curator slashed',
        testFn: async () => await unassignCuratorAfterUpdateDueTest(getClient(), testConfig),
      },
    ],
  }
}

/// -------
/// Deposit poke
/// -------

/**
 * The bond the current runtime takes for a description of `descriptionLength` bytes.
 */
function currentBond(client: Client<any, any>, descriptionLength: number): bigint {
  const depositBase = client.api.consts.bounties.bountyDepositBase.toBigInt()
  const perByte = client.api.consts.bounties.dataDepositPerByte.toBigInt()
  return depositBase + perByte * BigInt(descriptionLength)
}

/**
 * The bond a proposal took before https://github.com/polkadot-fellows/runtimes/pull/1114, which changed
 * `BountyDepositBase` from `system_para_deposit(0, 176)` to a flat 10 DOT (10 QUID on Kusama).
 *
 * `system_para_deposit(0, n)` is exactly `n` times `DataDepositPerByte` on both Asset Hubs, so the old bond is
 * `DataDepositPerByte * (176 + descriptionLength)`.
 */
function preRuntime1114Bond(client: Client<any, any>, descriptionLength: number): bigint {
  const perByte = client.api.consts.bounties.dataDepositPerByte.toBigInt()
  return perByte * (176n + BigInt(descriptionLength))
}

/**
 * Give a `Proposed` bounty a different bond, as a runtime with other deposit constants would have taken it.
 *
 * The proposer's reserve moves by the same amount, to or from their free balance, so the account still reserves
 * exactly what the bond says and its total balance is unchanged.
 */
async function setProposedBountyBond(client: Client<any, any>, bountyIndex: number, bond: bigint) {
  const bounty = await getBounty(client, bountyIndex)
  assert(bounty?.status.isProposed, `bounty ${bountyIndex} is not Proposed`)
  const increase = bond - bounty.bond.toBigInt()
  const proposer: string = bounty.proposer.toString()

  const account = await client.api.query.system.account(proposer)
  const free = account.data.free.toBigInt() - increase
  const reserved = account.data.reserved.toBigInt() + increase
  expect(free).toBeGreaterThan(0n)
  expect(reserved).toBeGreaterThanOrEqual(0n)

  await client.dev.setStorage({
    System: {
      account: [[[proposer], { ...account.toJSON(), data: { ...account.data.toJSON(), free, reserved } }]],
    },
    Bounties: {
      bounties: [[[bountyIndex], { ...bounty.toJSON(), bond }]],
    },
  })

  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(bond)
  expect((await client.api.query.system.account(proposer)).data.reserved.toBigInt()).toBe(reserved)
}

/**
 * The `TransactionFeePaid` event for `who` in the head block.
 */
async function getFeePaid(client: Client<any, any>, who: string): Promise<{ actualFee: bigint; tip: bigint }> {
  const events = await client.api.query.system.events()
  const encoded = encodeAddress(who, client.config.properties.addressEncoding)
  const feePaid = events.find(
    ({ event }) =>
      client.api.events.transactionPayment.TransactionFeePaid.is(event) && event.data.who.toString() === encoded,
  )
  assert(
    feePaid && client.api.events.transactionPayment.TransactionFeePaid.is(feePaid.event),
    `no fee event for ${who}`,
  )
  return { actualFee: feePaid.event.data.actualFee.toBigInt(), tip: feePaid.event.data.tip.toBigInt() }
}

/**
 * `poke_deposit` raises a bond taken at a lower, older deposit rate to the current rate, reserving the difference
 * from the proposer. Because the deposit changed, the call is free.
 *
 * https://github.com/polkadot-fellows/runtimes/pull/1114 raised `BountyDepositBase`, so proposals made before it
 * hold too small a bond. Bounties migrated from the relay chain also hold relay-era bonds below the current rate.
 * Anyone may poke, so Bob pokes Alice's proposal.
 *
 * 1. Alice proposes a bounty, and the bond follows the current formula
 * 2. Lower the bond to the rate before `BountyDepositBase` was raised, moving the difference from Alice's reserve to her free balance
 * 3. Bob pokes the deposit
 * 4. Verify `DepositPoked` with the old and the new bond, and that the call was free
 * 5. Verify the bond is current again, and the difference moved from Alice's free balance to her reserve
 * 6. Verify Bob paid no fee
 */
async function pokeDepositRaisesBondTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for raising a bond'
  const descriptionLength = stringToU8a(description).length

  // 1. Proposal at the current rate
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, description)
  const newBond = currentBond(client, descriptionLength)
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(newBond)

  // 2. Bond at the rate before `BountyDepositBase` was raised
  const oldBond = preRuntime1114Bond(client, descriptionLength)
  expect(oldBond).toBeLessThan(newBond)
  await setProposedBountyBond(client, bountyIndex, oldBond)

  const aliceBefore = await client.api.query.system.account(testAccounts.alice.address)
  const bobBefore = await client.api.query.system.account(testAccounts.bob.address)

  // 3. Bob pokes
  const pokeTx = client.api.tx.bounties.pokeDeposit(bountyIndex)
  const pokeEvents = await sendTransaction(pokeTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 4. DepositPoked, and a free call
  await checkEvents(
    pokeEvents,
    { section: 'bounties', method: 'DepositPoked' },
    { section: 'system', method: 'ExtrinsicSuccess' },
  )
    .redact({ redactKeys: /bountyId|weight/ })
    .toMatchSnapshot('poke raising a bond events')

  const events = await client.api.query.system.events()
  const poked = events.find(({ event }) => client.api.events.bounties.DepositPoked.is(event))
  assert(poked && client.api.events.bounties.DepositPoked.is(poked.event))
  // `DepositPoked` is newer than the API's type augmentation, so its fields are read by name.
  const pokedData = poked.event.data as any
  expect(pokedData.bountyId.toNumber()).toBe(bountyIndex)
  expect(pokedData.proposer.toString()).toBe(
    encodeAddress(testAccounts.alice.address, client.config.properties.addressEncoding),
  )
  expect(pokedData.oldDeposit.toBigInt()).toBe(oldBond)
  expect(pokedData.newDeposit.toBigInt()).toBe(newBond)

  // The poke's own `ExtrinsicSuccess`, not an inherent's, records whether it paid a fee.
  const pokeRecords = (await pokeEvents.events) as unknown as EventRecord[]
  const success = pokeRecords.find(({ event }) => client.api.events.system.ExtrinsicSuccess.is(event))
  assert(success && client.api.events.system.ExtrinsicSuccess.is(success.event))
  expect(success.event.data.dispatchInfo.paysFee.isNo).toBe(true)

  // 5. Bond current, difference reserved from Alice
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(newBond)
  const aliceAfter = await client.api.query.system.account(testAccounts.alice.address)
  expect(aliceAfter.data.reserved.toBigInt() - aliceBefore.data.reserved.toBigInt()).toBe(newBond - oldBond)
  expect(aliceBefore.data.free.toBigInt() - aliceAfter.data.free.toBigInt()).toBe(newBond - oldBond)

  // 6. No fee for Bob
  expect(await getFeePaid(client, testAccounts.bob.address)).toEqual({ actualFee: 0n, tip: 0n })
  const bobAfter = await client.api.query.system.account(testAccounts.bob.address)
  expect(bobAfter.data.free.toBigInt()).toBe(bobBefore.data.free.toBigInt())
}

/**
 * `poke_deposit` lowers a bond above the current rate, returning the excess to the proposer for free.
 *
 * Relay-chain bounty bonds charged 0.01 DOT per description byte against 0.00001 DOT on Asset Hub, so a relay-era
 * proposal with a long description holds more than the current formula asks. The test raises the bond by one
 * `BountyDepositBase` to stand for that. Here the proposer pokes their own bounty.
 *
 * 1. Alice proposes a bounty
 * 2. Raise the bond by one `BountyDepositBase`, moving the difference from Alice's free balance to her reserve
 * 3. Alice pokes the deposit
 * 4. Verify `DepositPoked` with the old and the new bond
 * 5. Verify the bond is current again, and the excess is back in Alice's free balance with no fee taken
 */
async function pokeDepositLowersBondTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for lowering a bond'
  const descriptionLength = stringToU8a(description).length

  // 1. Proposal at the current rate
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, description)
  const newBond = currentBond(client, descriptionLength)
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(newBond)

  // 2. Over-collateralised bond
  const excess = client.api.consts.bounties.bountyDepositBase.toBigInt()
  const oldBond = newBond + excess
  await setProposedBountyBond(client, bountyIndex, oldBond)

  const aliceBefore = await client.api.query.system.account(testAccounts.alice.address)

  // 3. Alice pokes
  const pokeTx = client.api.tx.bounties.pokeDeposit(bountyIndex)
  const pokeEvents = await sendTransaction(pokeTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // 4. DepositPoked
  await checkEvents(pokeEvents, { section: 'bounties', method: 'DepositPoked' })
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('poke lowering a bond events')

  const events = await client.api.query.system.events()
  const poked = events.find(({ event }) => client.api.events.bounties.DepositPoked.is(event))
  assert(poked && client.api.events.bounties.DepositPoked.is(poked.event))
  // `DepositPoked` is newer than the API's type augmentation, so its fields are read by name.
  const pokedData = poked.event.data as any
  expect(pokedData.bountyId.toNumber()).toBe(bountyIndex)
  expect(pokedData.oldDeposit.toBigInt()).toBe(oldBond)
  expect(pokedData.newDeposit.toBigInt()).toBe(newBond)

  // 5. Bond current, excess returned, no fee
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(newBond)
  expect(await getFeePaid(client, testAccounts.alice.address)).toEqual({ actualFee: 0n, tip: 0n })
  const aliceAfter = await client.api.query.system.account(testAccounts.alice.address)
  expect(aliceBefore.data.reserved.toBigInt() - aliceAfter.data.reserved.toBigInt()).toBe(excess)
  expect(aliceAfter.data.free.toBigInt() - aliceBefore.data.free.toBigInt()).toBe(excess)
}

/**
 * `poke_deposit` on a bond that already matches the current rate changes nothing and pays a normal fee, so the
 * call cannot be used for free.
 *
 * 1. Alice proposes a bounty, so its bond is current
 * 2. Bob pokes the deposit
 * 3. Verify no `DepositPoked`, and that the call succeeded and paid a fee
 * 4. Verify the bond and Alice's balances are unchanged, and Bob's free balance dropped by exactly the fee
 */
async function pokeDepositUnchangedTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for an unchanged bond'

  // 1. Proposal at the current rate
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, description)
  const bond = currentBond(client, stringToU8a(description).length)
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(bond)

  const aliceBefore = await client.api.query.system.account(testAccounts.alice.address)
  const bobBefore = await client.api.query.system.account(testAccounts.bob.address)

  // 2. Bob pokes
  const pokeTx = client.api.tx.bounties.pokeDeposit(bountyIndex)
  const pokeEvents = await sendTransaction(pokeTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 3. No DepositPoked; success with a fee
  await checkEvents(pokeEvents, { section: 'system', method: 'ExtrinsicSuccess' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('poke on an unchanged bond events')

  const events = await client.api.query.system.events()
  expect(events.filter(({ event }) => client.api.events.bounties.DepositPoked.is(event))).toHaveLength(0)
  // The poke's own `ExtrinsicSuccess`, not an inherent's, records whether it paid a fee.
  const pokeRecords = (await pokeEvents.events) as unknown as EventRecord[]
  const success = pokeRecords.find(({ event }) => client.api.events.system.ExtrinsicSuccess.is(event))
  assert(success && client.api.events.system.ExtrinsicSuccess.is(success.event))
  expect(success.event.data.dispatchInfo.paysFee.isYes).toBe(true)

  const { actualFee } = await getFeePaid(client, testAccounts.bob.address)
  expect(actualFee).toBeGreaterThan(0n)

  // 4. Nothing moved except Bob's fee
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(bond)
  const aliceAfter = await client.api.query.system.account(testAccounts.alice.address)
  expect(aliceAfter.data.free.toBigInt()).toBe(aliceBefore.data.free.toBigInt())
  expect(aliceAfter.data.reserved.toBigInt()).toBe(aliceBefore.data.reserved.toBigInt())
  const bobAfter = await client.api.query.system.account(testAccounts.bob.address)
  expect(bobBefore.data.free.toBigInt() - bobAfter.data.free.toBigInt()).toBe(actualFee)
}

/**
 * `poke_deposit` only applies to `Proposed` bounties: once approved, the bond is returned at funding, so it is never
 * recomputed.
 *
 * The bond is lowered first, so only the status check stands between the call and a change.
 *
 * 1. Alice proposes a bounty, and its bond is lowered to the rate before `BountyDepositBase` was raised
 * 2. `Treasurer` approves the bounty
 * 3. Alice pokes the deposit
 * 4. Verify the call failed with `UnexpectedStatus`
 * 5. Verify the bond and Alice's reserve are unchanged
 */
async function pokeDepositApprovedBountyTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for poking an approved bounty'

  // 1. Out-of-date bond
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, description)
  const oldBond = preRuntime1114Bond(client, stringToU8a(description).length)
  await setProposedBountyBond(client, bountyIndex, oldBond)

  // 2. Approved
  await dispatchSetupCall(client, client.api.tx.bounties.approveBounty(bountyIndex), { Origins: 'Treasurer' })
  expect((await getBounty(client, bountyIndex)).status.isApproved).toBe(true)
  const aliceReservedBefore = (await client.api.query.system.account(testAccounts.alice.address)).data.reserved

  // 3. Alice pokes
  const pokeTx = client.api.tx.bounties.pokeDeposit(bountyIndex)
  const pokeEvents = await sendTransaction(pokeTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // 4. UnexpectedStatus
  await checkEvents(pokeEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('poke on an approved bounty failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  expect(client.api.errors.bounties.UnexpectedStatus.is(dispatchError.asModule)).toBe(true)

  // 5. Nothing changed
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isApproved).toBe(true)
  expect(bounty.bond.toBigInt()).toBe(oldBond)
  const aliceReservedAfter = (await client.api.query.system.account(testAccounts.alice.address)).data.reserved
  expect(aliceReservedAfter.toBigInt()).toBe(aliceReservedBefore.toBigInt())
}

/**
 * `poke_deposit` on an index that holds no bounty fails with `InvalidIndex`.
 *
 * 1. Pick an index above `BountyCount`, and verify no bounty is stored there
 * 2. Alice pokes it
 * 3. Verify the call failed with `InvalidIndex`
 */
async function pokeDepositMissingBountyTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  // 1. Unused index
  const missingIndex = (await getBountyCount(client)) + NON_EXISTENT_BOUNTY_INDEX_OFFSET
  expect(await getBounty(client, missingIndex)).toBeNull()

  // 2. Alice pokes
  const pokeTx = client.api.tx.bounties.pokeDeposit(missingIndex)
  const pokeEvents = await sendTransaction(pokeTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // 3. InvalidIndex
  await checkEvents(pokeEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('poke on a missing bounty failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  expect(client.api.errors.bounties.InvalidIndex.is(dispatchError.asModule)).toBe(true)
}

/**
 * `poke_deposit` requires a signed origin. Root, dispatched through the scheduler, is rejected with `BadOrigin`.
 *
 * The bond is lowered first, so a call that got past the origin check would change it.
 *
 * 1. Alice proposes a bounty, and its bond is lowered to the rate before `BountyDepositBase` was raised
 * 2. Dispatch `poke_deposit` from Root
 * 3. Verify the dispatch failed with `BadOrigin`
 * 4. Verify the bond is unchanged
 */
async function pokeDepositRootOriginTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for poking from Root'

  // 1. Out-of-date bond
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, description)
  const oldBond = preRuntime1114Bond(client, stringToU8a(description).length)
  await setProposedBountyBond(client, bountyIndex, oldBond)

  // 2. Root pokes
  const pokeTx = client.api.tx.bounties.pokeDeposit(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    pokeTx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. BadOrigin
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('poke from Root dispatched')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr)
  expect(results[0].asErr.isBadOrigin).toBe(true)

  // 4. Bond unchanged
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(oldBond)
}

/**
 * `poke_deposit` fails when the proposer cannot reserve the increase, and leaves the old bond in place.
 *
 * A relay-era proposal whose proposer has since spent their free balance is in this state. The reserve fails inside
 * `pallet_balances`, so the error is `balances.InsufficientBalance`.
 *
 * 1. Alice proposes a bounty, and its bond is lowered to the rate before `BountyDepositBase` was raised
 * 2. Set Alice's free balance to the existential deposit, below the increase
 * 3. Bob pokes the deposit
 * 4. Verify the call failed with `balances.InsufficientBalance`
 * 5. Verify the bond and Alice's balances are unchanged
 */
async function pokeDepositInsufficientBalanceTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty for a poke the proposer cannot pay'
  const descriptionLength = stringToU8a(description).length

  // 1. Out-of-date bond
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, description)
  const oldBond = preRuntime1114Bond(client, descriptionLength)
  await setProposedBountyBond(client, bountyIndex, oldBond)

  // 2. Alice keeps only the existential deposit free
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const increase = currentBond(client, descriptionLength) - oldBond
  expect(increase).toBeGreaterThan(existentialDeposit)
  const aliceAccount = await client.api.query.system.account(testAccounts.alice.address)
  await client.dev.setStorage({
    System: {
      account: [
        [
          [testAccounts.alice.address],
          { ...aliceAccount.toJSON(), data: { ...aliceAccount.data.toJSON(), free: existentialDeposit } },
        ],
      ],
    },
  })
  const aliceBefore = await client.api.query.system.account(testAccounts.alice.address)
  expect(aliceBefore.data.free.toBigInt()).toBe(existentialDeposit)

  // 3. Bob pokes
  const pokeTx = client.api.tx.bounties.pokeDeposit(bountyIndex)
  const pokeEvents = await sendTransaction(pokeTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 4. balances.InsufficientBalance
  await checkEvents(pokeEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('poke the proposer cannot pay failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  expect(client.api.errors.balances.InsufficientBalance.is(dispatchError.asModule)).toBe(true)

  // 5. Nothing changed
  expect((await getBounty(client, bountyIndex)).bond.toBigInt()).toBe(oldBond)
  const aliceAfter = await client.api.query.system.account(testAccounts.alice.address)
  expect(aliceAfter.data.free.toBigInt()).toBe(existentialDeposit)
  expect(aliceAfter.data.reserved.toBigInt()).toBe(aliceBefore.data.reserved.toBigInt())
}

/**
 * Deposit poke tests: `poke_deposit` against bonds taken at other deposit rates, and its error paths.
 */
export function depositPokeTests(getClient: () => Client<any, any>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Deposit poke',
    children: [
      {
        kind: 'test',
        label: 'poke deposit raises a bond below the current rate - DepositPoked, fee waived',
        testFn: async () => await pokeDepositRaisesBondTest(getClient()),
      },
      {
        kind: 'test',
        label: 'poke deposit lowers a bond above the current rate - DepositPoked',
        testFn: async () => await pokeDepositLowersBondTest(getClient()),
      },
      {
        kind: 'test',
        label: 'poke deposit on an up-to-date bond - no event, fee charged',
        testFn: async () => await pokeDepositUnchangedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'poke deposit on an approved bounty - UnexpectedStatus',
        testFn: async () => await pokeDepositApprovedBountyTest(getClient()),
      },
      {
        kind: 'test',
        label: 'poke deposit on a missing bounty - InvalidIndex',
        testFn: async () => await pokeDepositMissingBountyTest(getClient()),
      },
      {
        kind: 'test',
        label: 'poke deposit from Root - BadOrigin',
        testFn: async () => await pokeDepositRootOriginTest(getClient()),
      },
      {
        kind: 'test',
        label: 'poke deposit when the proposer cannot cover the increase - InsufficientBalance',
        testFn: async () => await pokeDepositInsufficientBalanceTest(getClient()),
      },
    ],
  }
}

/// -------
/// Origins and spend limits
/// -------

/**
 * A signed account cannot use the calls reserved for `SpendOrigin` and `RejectOrigin`: `approve_bounty`,
 * `approve_bounty_with_curator`, `propose_curator` and `close_bounty` all fail with `BadOrigin`.
 *
 * Each call targets a bounty in a state where `Treasurer` would succeed, so the origin is the only reason it fails.
 * The four calls go in one `utility.force_batch`, which runs every item and reports each failure on its own.
 *
 * 1. Create a `Funded` bounty, then propose a second bounty that stays `Proposed`
 * 2. Charlie sends a `force_batch`: approve and approve-with-curator on the proposed bounty, propose-curator and close
 *    on the funded one
 * 3. Verify the batch completed with errors, with four `ItemFailed`, each `BadOrigin`
 * 4. Verify both bounties are unchanged and nothing was queued for funding
 */
async function signedOriginRejectedTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. One funded and one proposed bounty
  const fundedIndex = await createFundedBounty(client, bountyValue, 'Test bounty funded, for a signed origin')
  const proposedIndex = await proposeBounty(
    client,
    testAccounts.alice,
    bountyValue,
    'Test bounty proposed, for a signed origin',
  )
  const aliceReservedBefore = (await client.api.query.system.account(testAccounts.alice.address)).data.reserved

  // 2. Charlie tries all four privileged calls
  const batchTx = client.api.tx.utility.forceBatch([
    client.api.tx.bounties.approveBounty(proposedIndex),
    client.api.tx.bounties.approveBountyWithCurator(proposedIndex, testAccounts.bob.address, curatorFee),
    client.api.tx.bounties.proposeCurator(fundedIndex, testAccounts.bob.address, curatorFee),
    client.api.tx.bounties.closeBounty(fundedIndex),
  ])
  const batchEvents = await sendTransaction(batchTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 3. Four BadOrigin failures
  await checkEvents(batchEvents, 'utility').toMatchSnapshot('signed origin batch events')

  const records = (await batchEvents.events) as unknown as EventRecord[]
  const failures = records.filter(({ event }) => client.api.events.utility.ItemFailed.is(event))
  expect(failures).toHaveLength(4)
  for (const { event } of failures) {
    assert(client.api.events.utility.ItemFailed.is(event))
    expect(event.data.error.isBadOrigin).toBe(true)
  }
  expect(records.filter(({ event }) => client.api.events.utility.ItemCompleted.is(event))).toHaveLength(0)
  expect(records.some(({ event }) => client.api.events.utility.BatchCompletedWithErrors.is(event))).toBe(true)

  // 4. Nothing changed
  const proposed = await getBounty(client, proposedIndex)
  expect(proposed.status.isProposed).toBe(true)
  expect(proposed.fee.toBigInt()).toBe(0n)
  const funded = await getBounty(client, fundedIndex)
  expect(funded.status.isFunded).toBe(true)
  expect(funded.fee.toBigInt()).toBe(0n)
  expect(await getBountyApprovals(client)).not.toContain(proposedIndex)
  const aliceReservedAfter = (await client.api.query.system.account(testAccounts.alice.address)).data.reserved
  expect(aliceReservedAfter.toBigInt()).toBe(aliceReservedBefore.toBigInt())
}

/**
 * `SmallTipper`, the lowest `Spender` track, can approve a bounty worth exactly its spend limit: the `Spender` arm of
 * `SpendOrigin` passes when the bounty value is at most the track's limit.
 *
 * 1. Alice proposes a bounty worth exactly the `SmallTipper` limit
 * 2. Dispatch `approve_bounty` from `SmallTipper`
 * 3. Verify the dispatch succeeded and `BountyApproved` was emitted
 * 4. Verify the bounty is `Approved` and queued for funding
 */
async function smallTipperApprovesAtLimitTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice'])

  // 1. Bounty at the limit
  const bountyValue = testConfig.smallTipperSpendLimit
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, 'Test bounty at the tipper limit')

  // 2. SmallTipper approves
  const approveTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveTx.method.toHex(),
    { Origins: 'SmallTipper' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Success and BountyApproved
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task|index/ })
    .toMatchSnapshot('small tipper approval at the limit events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isOk, `approve_bounty failed: ${results[0].toString()}`)

  const events = await client.api.query.system.events()
  const approved = events.find(({ event }) => client.api.events.bounties.BountyApproved.is(event))
  assert(approved && client.api.events.bounties.BountyApproved.is(approved.event))
  expect(approved.event.data.index.toNumber()).toBe(bountyIndex)

  // 4. Approved and queued
  expect((await getBounty(client, bountyIndex)).status.isApproved).toBe(true)
  expect(await getBountyApprovals(client)).toContain(bountyIndex)
}

/**
 * `SmallTipper` cannot approve a bounty worth one unit more than its spend limit: the call fails with the treasury's
 * `InsufficientPermission`.
 *
 * 1. Alice proposes a bounty worth the `SmallTipper` limit plus one
 * 2. Dispatch `approve_bounty` from `SmallTipper`
 * 3. Verify the dispatch failed with `treasury.InsufficientPermission`
 * 4. Verify the bounty is still `Proposed` and not queued
 */
async function smallTipperApprovesAboveLimitTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice'])

  // 1. Bounty one unit above the limit
  const bountyValue = testConfig.smallTipperSpendLimit + 1n
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, 'Test bounty above the tipper limit')

  // 2. SmallTipper approves
  const approveTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveTx.method.toHex(),
    { Origins: 'SmallTipper' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. InsufficientPermission
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('small tipper approval above the limit events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(client.api.errors.treasury.InsufficientPermission.is(results[0].asErr.asModule)).toBe(true)

  // 4. Still Proposed
  expect((await getBounty(client, bountyIndex)).status.isProposed).toBe(true)
  expect(await getBountyApprovals(client)).not.toContain(bountyIndex)
}

/**
 * `approve_bounty_with_curator` checks the spend limit too: `SmallTipper` cannot approve, with a curator, a bounty
 * worth one unit more than its limit.
 *
 * 1. Alice proposes a bounty worth the `SmallTipper` limit plus one
 * 2. Dispatch `approve_bounty_with_curator` from `SmallTipper`, with Bob as curator
 * 3. Verify the dispatch failed with `treasury.InsufficientPermission`
 * 4. Verify the bounty is still `Proposed` with no curator fee, and not queued
 */
async function smallTipperApprovesWithCuratorAboveLimitTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice'])

  // 1. Bounty one unit above the limit
  const bountyValue = testConfig.smallTipperSpendLimit + 1n
  const curatorFee = bountyValue / 10n
  const bountyIndex = await proposeBounty(
    client,
    testAccounts.alice,
    bountyValue,
    'Test bounty with curator above the tipper limit',
  )

  // 2. SmallTipper approves with a curator
  const approveTx = client.api.tx.bounties.approveBountyWithCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    approveTx.method.toHex(),
    { Origins: 'SmallTipper' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. InsufficientPermission
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('small tipper approval with curator above the limit events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(client.api.errors.treasury.InsufficientPermission.is(results[0].asErr.asModule)).toBe(true)

  // 4. Still Proposed, no fee recorded
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isProposed).toBe(true)
  expect(bounty.fee.toBigInt()).toBe(0n)
  expect(await getBountyApprovals(client)).not.toContain(bountyIndex)
}

/**
 * `propose_curator` checks the spend limit as well: `SmallTipper` cannot propose a curator for a funded bounty worth
 * more than its limit.
 *
 * 1. Create a `Funded` bounty, and verify its value is above the `SmallTipper` limit
 * 2. Dispatch `propose_curator` from `SmallTipper`, with Bob as curator
 * 3. Verify the dispatch failed with `treasury.InsufficientPermission`
 * 4. Verify the bounty is still `Funded` with no curator fee
 */
async function smallTipperProposesCuratorAboveLimitTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Funded bounty above the limit
  expect(bountyValue).toBeGreaterThan(testConfig.smallTipperSpendLimit)
  const bountyIndex = await createFundedBounty(client, bountyValue, 'Test bounty for a tipper proposing a curator')

  // 2. SmallTipper proposes a curator
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'SmallTipper' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. InsufficientPermission
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('small tipper curator proposal above the limit events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(client.api.errors.treasury.InsufficientPermission.is(results[0].asErr.asModule)).toBe(true)

  // 4. Still Funded
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isFunded).toBe(true)
  expect(bounty.fee.toBigInt()).toBe(0n)
}

/**
 * `Treasurer`, the highest `Spender` track, still has a spend limit: it cannot approve a bounty worth one unit more
 * than that limit.
 *
 * 1. Alice proposes a bounty worth the `Treasurer` limit plus one
 * 2. Dispatch `approve_bounty` from `Treasurer`
 * 3. Verify the dispatch failed with `treasury.InsufficientPermission`
 * 4. Verify the bounty is still `Proposed` and not queued
 */
async function treasurerApprovesAboveLimitTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice'])

  // 1. Bounty one unit above the Treasurer limit
  const bountyValue = testConfig.treasurerSpendLimit + 1n
  const bountyIndex = await proposeBounty(
    client,
    testAccounts.alice,
    bountyValue,
    'Test bounty above the treasurer limit',
  )

  // 2. Treasurer approves
  const approveTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveTx.method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. InsufficientPermission
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('treasurer approval above the limit events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(client.api.errors.treasury.InsufficientPermission.is(results[0].asErr.asModule)).toBe(true)

  // 4. Still Proposed
  expect((await getBounty(client, bountyIndex)).status.isProposed).toBe(true)
  expect(await getBountyApprovals(client)).not.toContain(bountyIndex)
}

/**
 * Root, the other arm of `SpendOrigin`, has no spend limit: it approves a bounty worth more than the `Treasurer`
 * limit, which no `Spender` track could approve.
 *
 * 1. Alice proposes a bounty worth the `Treasurer` limit plus one
 * 2. Dispatch `approve_bounty` from Root
 * 3. Verify the dispatch succeeded and `BountyApproved` was emitted
 * 4. Verify the bounty is `Approved` and queued for funding
 */
async function rootApprovesAboveTreasurerLimitTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice'])

  // 1. Bounty one unit above the Treasurer limit
  const bountyValue = testConfig.treasurerSpendLimit + 1n
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, 'Test bounty approved by Root')

  // 2. Root approves
  const approveTx = client.api.tx.bounties.approveBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    approveTx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Success and BountyApproved
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task|index/ })
    .toMatchSnapshot('root approval above the treasurer limit events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isOk, `approve_bounty failed: ${results[0].toString()}`)

  const events = await client.api.query.system.events()
  const approved = events.find(({ event }) => client.api.events.bounties.BountyApproved.is(event))
  assert(approved && client.api.events.bounties.BountyApproved.is(approved.event))
  expect(approved.event.data.index.toNumber()).toBe(bountyIndex)

  // 4. Approved and queued
  expect((await getBounty(client, bountyIndex)).status.isApproved).toBe(true)
  expect(await getBountyApprovals(client)).toContain(bountyIndex)
}

/**
 * A `Spender` track other than `Treasurer` is not a `RejectOrigin`: `BigSpender` can neither close a bounty nor
 * unassign its curator, and both fail with `BadOrigin`.
 *
 * `BigSpender` passes `SpendOrigin`, so this checks that `RejectOrigin` is the narrower origin. The bounty is
 * `Active`, where `Treasurer` could do either.
 *
 * 1. Create an `Active` bounty with Bob as curator
 * 2. Dispatch `close_bounty` and `unassign_curator` from `BigSpender` in the same block
 * 3. Verify both dispatches failed with `BadOrigin`
 * 4. Verify the bounty is still `Active` with Bob as curator, and his deposit is still reserved
 */
async function bigSpenderRejectOriginTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Active bounty
  const bountyIndex = await createActiveBounty(
    client,
    bountyValue,
    curatorFee,
    testAccounts.bob,
    'Test bounty for a non-treasurer spender',
  )
  const curatorDeposit = (await getBounty(client, bountyIndex)).curatorDeposit.toBigInt()
  const bobReservedBefore = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved

  // 2. BigSpender closes and unassigns
  const closeTx = client.api.tx.bounties.closeBounty(bountyIndex)
  const unassignTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  await scheduleInlineCallListWithSameOrigin(
    client,
    [closeTx.method.toHex(), unassignTx.method.toHex()],
    { Origins: 'BigSpender' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Two BadOrigin failures
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('big spender close and unassign events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(2)
  for (const result of results) {
    assert(result.isErr, `expected a failed dispatch, got ${result.toString()}`)
    expect(result.asErr.isBadOrigin).toBe(true)
  }

  // 4. Still Active, deposit still held
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isActive).toBe(true)
  expect(bounty.status.asActive.curator.toString()).toBe(
    encodeAddress(testAccounts.bob.address, client.config.properties.addressEncoding),
  )
  expect(bounty.curatorDeposit.toBigInt()).toBe(curatorDeposit)
  const bobReservedAfter = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved
  expect(bobReservedAfter.toBigInt()).toBe(bobReservedBefore.toBigInt())
}

/**
 * Root, the other arm of `RejectOrigin`, can close a funded bounty, and the bounty's funds return to the treasury pot.
 *
 * 1. Create a `Funded` bounty
 * 2. Dispatch `close_bounty` from Root
 * 3. Verify the dispatch succeeded, with `BountyCanceled` and a transfer of the bounty's whole value to the pot
 * 4. Verify the bounty and its description are removed, the pot grew by the value, and the try-state invariants hold
 */
async function rootClosesFundedBountyTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER

  // 1. Funded bounty
  const bountyIndex = await createFundedBounty(client, bountyValue, 'Test bounty closed by Root')
  const potFreeBefore = await getTreasuryPotFree(client)

  // 2. Root closes
  const closeTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeTx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Success, BountyCanceled, value back to the pot
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task|index/ })
    .toMatchSnapshot('root close events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isOk, `close_bounty failed: ${results[0].toString()}`)

  const events = await client.api.query.system.events()
  const canceled = events.find(({ event }) => client.api.events.bounties.BountyCanceled.is(event))
  assert(canceled && client.api.events.bounties.BountyCanceled.is(canceled.event))
  expect(canceled.event.data.index.toNumber()).toBe(bountyIndex)

  // On some runtimes the collator pot pays the block author in every block, so the bounty's transfer is found by
  // its sender, and plain transfers are left out of the snapshot.
  const pot = client.api.consts.treasury.potAccount.toHex()
  const account = bountyAccount(client, bountyIndex)
  const transfers = events.filter(
    ({ event }) => client.api.events.balances.Transfer.is(event) && event.data.from.toHex() === account,
  )
  expect(transfers).toHaveLength(1)
  assert(client.api.events.balances.Transfer.is(transfers[0].event))
  expect(transfers[0].event.data.to.toHex()).toBe(pot)
  expect(transfers[0].event.data.amount.toBigInt()).toBe(bountyValue)

  // 4. Removed, pot refilled, invariants hold
  expect(await getBounty(client, bountyIndex)).toBeNull()
  expect(await getBountyDescription(client, bountyIndex)).toBeNull()
  expect((await getTreasuryPotFree(client)) - potFreeBefore).toBe(bountyValue)
  await checkBountiesTryState(client)
}

/**
 * Origin and spend limit tests: the `Root` and `Spender` arms of `SpendOrigin`, their limits, and the origins that
 * `SpendOrigin` and `RejectOrigin` reject.
 */
export function originAndSpendLimitTests(
  getClient: () => Client<any, any>,
  testConfig: BountiesTestConfig,
): RootTestTree {
  return {
    kind: 'describe',
    label: 'Origins and spend limits',
    children: [
      {
        kind: 'test',
        label: 'approve, approve with curator, propose curator, close from a signed origin - BadOrigin',
        testFn: async () => await signedOriginRejectedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'approve from SmallTipper at its spend limit - BountyApproved',
        testFn: async () => await smallTipperApprovesAtLimitTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'approve from SmallTipper above its spend limit - InsufficientPermission',
        testFn: async () => await smallTipperApprovesAboveLimitTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'approve with curator from SmallTipper above its spend limit - InsufficientPermission',
        testFn: async () => await smallTipperApprovesWithCuratorAboveLimitTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'propose curator from SmallTipper above its spend limit - InsufficientPermission',
        testFn: async () => await smallTipperProposesCuratorAboveLimitTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'approve from Treasurer above its spend limit - InsufficientPermission',
        testFn: async () => await treasurerApprovesAboveLimitTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'approve from Root above the Treasurer limit - BountyApproved',
        testFn: async () => await rootApprovesAboveTreasurerLimitTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'close and unassign curator from a non-Treasurer Spender - BadOrigin',
        testFn: async () => await bigSpenderRejectOriginTest(getClient()),
      },
      {
        kind: 'test',
        label: 'close from Root - BountyCanceled',
        testFn: async () => await rootClosesFundedBountyTest(getClient()),
      },
    ],
  }
}

/// -------
/// Curator unassign by origin
/// -------

/**
 * A curator who has been approved with a bounty, but not yet funded, can withdraw themselves: the bounty goes back
 * to `Approved` and stays queued for funding.
 *
 * 1. Alice proposes a bounty, and `Treasurer` approves it with Bob as curator
 * 2. Bob unassigns himself
 * 3. Verify `CuratorUnassigned`
 * 4. Verify the bounty is `Approved` and still queued, and Bob holds no deposit
 */
async function curatorLeavesApprovedWithCuratorTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Approved with Bob as curator
  const bountyIndex = await proposeBounty(client, testAccounts.alice, bountyValue, 'Test bounty the curator leaves')
  await dispatchSetupCall(
    client,
    client.api.tx.bounties.approveBountyWithCurator(bountyIndex, testAccounts.bob.address, curatorFee),
    { Origins: 'Treasurer' },
  )
  expect((await getBounty(client, bountyIndex)).status.isApprovedWithCurator).toBe(true)
  const bobReservedBefore = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved

  // 2. Bob unassigns himself
  const unassignTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  const unassignEvents = await sendTransaction(unassignTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 3. CuratorUnassigned
  await checkEvents(unassignEvents, 'bounties')
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator leaves approved with curator events')
  const events = await client.api.query.system.events()
  const unassigned = events.find(({ event }) => client.api.events.bounties.CuratorUnassigned.is(event))
  assert(unassigned && client.api.events.bounties.CuratorUnassigned.is(unassigned.event))
  expect(unassigned.event.data.bountyId.toNumber()).toBe(bountyIndex)

  // 4. Approved, queued, no deposit
  expect((await getBounty(client, bountyIndex)).status.isApproved).toBe(true)
  expect(await getBountyApprovals(client)).toContain(bountyIndex)
  const bobReservedAfter = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved
  expect(bobReservedAfter.toBigInt()).toBe(bobReservedBefore.toBigInt())
}

/**
 * A proposed curator can decline before accepting: the bounty goes back to `Funded`, with no deposit involved.
 *
 * 1. Create a `Funded` bounty, and `Treasurer` proposes Bob as curator
 * 2. Bob unassigns himself
 * 3. Verify `CuratorUnassigned`
 * 4. Verify the bounty is `Funded`, and Bob's reserve did not move
 */
async function curatorLeavesCuratorProposedTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Bob proposed as curator
  const bountyIndex = await createFundedBounty(client, bountyValue, 'Test bounty the proposed curator declines')
  await dispatchSetupCall(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee),
    {
      Origins: 'Treasurer',
    },
  )
  expect((await getBounty(client, bountyIndex)).status.isCuratorProposed).toBe(true)
  const bobReservedBefore = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved

  // 2. Bob unassigns himself
  const unassignTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  const unassignEvents = await sendTransaction(unassignTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 3. CuratorUnassigned
  await checkEvents(unassignEvents, 'bounties')
    .redact({ redactKeys: /bountyId/ })
    .toMatchSnapshot('curator leaves curator proposed events')
  const events = await client.api.query.system.events()
  const unassigned = events.find(({ event }) => client.api.events.bounties.CuratorUnassigned.is(event))
  assert(unassigned && client.api.events.bounties.CuratorUnassigned.is(unassigned.event))
  expect(unassigned.event.data.bountyId.toNumber()).toBe(bountyIndex)

  // 4. Funded, reserve unchanged
  expect((await getBounty(client, bountyIndex)).status.isFunded).toBe(true)
  const bobReservedAfter = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved
  expect(bobReservedAfter.toBigInt()).toBe(bobReservedBefore.toBigInt())
}

/**
 * Only the proposed curator, or a `RejectOrigin`, can unassign a curator who has not accepted yet. Any other signed
 * account fails with `BadOrigin`.
 *
 * 1. Create a `Funded` bounty, and `Treasurer` proposes Bob as curator
 * 2. Charlie tries to unassign Bob
 * 3. Verify the call failed with `BadOrigin`
 * 4. Verify the bounty is still `CuratorProposed` with Bob
 */
async function otherAccountUnassignsCuratorProposedTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Bob proposed as curator
  const bountyIndex = await createFundedBounty(client, bountyValue, 'Test bounty another account unassigns')
  await dispatchSetupCall(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee),
    {
      Origins: 'Treasurer',
    },
  )

  // 2. Charlie unassigns
  const unassignTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  const unassignEvents = await sendTransaction(unassignTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 3. BadOrigin
  await checkEvents(unassignEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('other account unassigns proposed curator failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  expect(ev.event.data.dispatchError.isBadOrigin).toBe(true)

  // 4. Still CuratorProposed with Bob
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isCuratorProposed).toBe(true)
  expect(bounty.status.asCuratorProposed.curator.toString()).toBe(
    encodeAddress(testAccounts.bob.address, client.config.properties.addressEncoding),
  )
}

/**
 * Once a curator has awarded a bounty, they can no longer walk away from it: in `PendingPayout`, only a
 * `RejectOrigin` can unassign the curator, and the curator's own call fails with `BadOrigin`.
 *
 * 1. Create an `Active` bounty with Bob as curator, and Bob awards it to Alice
 * 2. Bob tries to unassign himself
 * 3. Verify the call failed with `BadOrigin`
 * 4. Verify the bounty is still `PendingPayout`, and Bob's deposit is still reserved
 */
async function curatorLeavesPendingPayoutTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Awarded bounty
  const bountyIndex = await createActiveBounty(
    client,
    bountyValue,
    curatorFee,
    testAccounts.bob,
    'Test bounty the curator leaves after awarding',
  )
  await sendTransaction(
    client.api.tx.bounties.awardBounty(bountyIndex, testAccounts.alice.address).signAsync(testAccounts.bob),
  )
  await client.dev.newBlock()
  const awarded = await getBounty(client, bountyIndex)
  assert(awarded.status.isPendingPayout, `bounty ${bountyIndex} was not awarded`)
  const curatorDeposit = awarded.curatorDeposit.toBigInt()
  const bobReservedBefore = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved

  // 2. Bob unassigns himself
  const unassignTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  const unassignEvents = await sendTransaction(unassignTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // 3. BadOrigin
  await checkEvents(unassignEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('curator leaves pending payout failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  expect(ev.event.data.dispatchError.isBadOrigin).toBe(true)

  // 4. Still PendingPayout, deposit held
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isPendingPayout).toBe(true)
  expect(bounty.curatorDeposit.toBigInt()).toBe(curatorDeposit)
  const bobReservedAfter = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved
  expect(bobReservedAfter.toBigInt()).toBe(bobReservedBefore.toBigInt())
}

/**
 * Before funding, a curator approved with the bounty can be unassigned only by themselves or a `RejectOrigin`. Any
 * other signed account fails with `BadOrigin`.
 *
 * 1. Alice proposes a bounty, and `Treasurer` approves it with Bob as curator
 * 2. Charlie tries to unassign Bob
 * 3. Verify the call failed with `BadOrigin`
 * 4. Verify the bounty is still `ApprovedWithCurator` with Bob, and still queued
 */
async function otherAccountUnassignsApprovedWithCuratorTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Approved with Bob as curator
  const bountyIndex = await proposeBounty(
    client,
    testAccounts.alice,
    bountyValue,
    'Test bounty another account unassigns before funding',
  )
  await dispatchSetupCall(
    client,
    client.api.tx.bounties.approveBountyWithCurator(bountyIndex, testAccounts.bob.address, curatorFee),
    { Origins: 'Treasurer' },
  )

  // 2. Charlie unassigns
  const unassignTx = client.api.tx.bounties.unassignCurator(bountyIndex)
  const unassignEvents = await sendTransaction(unassignTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 3. BadOrigin
  await checkEvents(unassignEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('other account unassigns approved curator failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  expect(ev.event.data.dispatchError.isBadOrigin).toBe(true)

  // 4. Still ApprovedWithCurator with Bob, still queued
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isApprovedWithCurator).toBe(true)
  expect(bounty.status.asApprovedWithCurator.curator.toString()).toBe(
    encodeAddress(testAccounts.bob.address, client.config.properties.addressEncoding),
  )
  expect(await getBountyApprovals(client)).toContain(bountyIndex)
}

/**
 * Curator unassign tests by origin: the curator leaving in each state where they may, and the signed accounts that
 * may not unassign.
 */
export function curatorUnassignByOriginTests(getClient: () => Client<any, any>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Curator unassign by origin',
    children: [
      {
        kind: 'test',
        label: 'unassign curator by the curator in ApprovedWithCurator - CuratorUnassigned',
        testFn: async () => await curatorLeavesApprovedWithCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'unassign curator by the curator in CuratorProposed - CuratorUnassigned',
        testFn: async () => await curatorLeavesCuratorProposedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'unassign curator by another account in CuratorProposed - BadOrigin',
        testFn: async () => await otherAccountUnassignsCuratorProposedTest(getClient()),
      },
      {
        kind: 'test',
        label: 'unassign curator by the curator in PendingPayout - BadOrigin',
        testFn: async () => await curatorLeavesPendingPayoutTest(getClient()),
      },
      {
        kind: 'test',
        label: 'unassign curator by another account in ApprovedWithCurator - BadOrigin',
        testFn: async () => await otherAccountUnassignsApprovedWithCuratorTest(getClient()),
      },
    ],
  }
}

/// -------
/// Closing a bounty
/// -------

/** 1 USDT, which has 6 decimals on both Asset Hubs. */
const USDT_UNIT = 1_000_000n

/**
 * Closing a funded bounty sweeps every asset its account holds back to the treasury pot, not only the native token.
 *
 * Bounty accounts can receive other assets by plain transfer. The runtime's `TransferAllAssets` moves the native
 * token and each of its `BountyRelevantAssets`, USDT among them, to the pot when the bounty is closed.
 *
 * 1. Create a `Funded` bounty
 * 2. Give Alice USDT, keeping the asset's account and supply counters consistent
 * 3. Alice transfers USDT to the bounty account
 * 4. `Treasurer` closes the bounty
 * 5. Verify `BountyCanceled`, and transfers of the whole native balance and the whole USDT balance to the pot
 * 6. Verify the bounty account holds neither, the pot grew by both, and the try-state invariants hold
 */
async function closeBountyHoldingUsdtTest(client: Client<any, any>, testConfig: BountiesTestConfig) {
  await setupTestAccounts(client, ['alice'])

  const usdt = testConfig.usdtAssetId
  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const aliceUsdt = 10n * USDT_UNIT
  const sentUsdt = 5n * USDT_UNIT

  // 1. Funded bounty
  const bountyIndex = await createFundedBounty(client, bountyValue, 'Test bounty that also holds USDT')
  const account = bountyAccount(client, bountyIndex)
  expect((await client.api.query.system.account(account)).data.free.toBigInt()).toBe(bountyValue)

  // 2. USDT for Alice. USDT is a sufficient asset, so the holder's `sufficients` and the asset's `accounts`,
  // `sufficients` and `supply` all count the new balance.
  const details = (await client.api.query.assets.asset(usdt)).unwrap()
  expect(details.isSufficient.isTrue).toBe(true)
  const aliceAccount = await client.api.query.system.account(testAccounts.alice.address)
  await client.dev.setStorage({
    System: {
      account: [
        [
          [testAccounts.alice.address],
          { ...aliceAccount.toJSON(), sufficients: aliceAccount.sufficients.toNumber() + 1 },
        ],
      ],
    },
    Assets: {
      asset: [
        [
          [usdt],
          {
            ...details.toJSON(),
            supply: details.supply.toBigInt() + aliceUsdt,
            accounts: details.accounts.toNumber() + 1,
            sufficients: details.sufficients.toNumber() + 1,
          },
        ],
      ],
      account: [[[usdt, testAccounts.alice.address], { balance: aliceUsdt, status: 'Liquid', reason: 'Sufficient' }]],
    },
  })
  expect((await client.api.query.assets.account(usdt, testAccounts.alice.address)).unwrap().balance.toBigInt()).toBe(
    aliceUsdt,
  )

  // 3. USDT into the bounty account
  const transferEvents = await sendTransaction(
    client.api.tx.assets.transfer(usdt, account, sentUsdt).signAsync(testAccounts.alice),
  )
  await client.dev.newBlock()
  const transferRecords = (await transferEvents.events) as unknown as EventRecord[]
  const transferFailed = transferRecords.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(!transferFailed, `USDT transfer to the bounty account failed: ${transferFailed?.event.data.toString()}`)
  expect((await client.api.query.assets.account(usdt, account)).unwrap().balance.toBigInt()).toBe(sentUsdt)

  const pot = client.api.consts.treasury.potAccount.toHex()
  const potFreeBefore = await getTreasuryPotFree(client)
  const potUsdtBefore = (await client.api.query.assets.account(usdt, pot)).unwrapOr(null)?.balance.toBigInt() ?? 0n

  // 4. Treasurer closes
  const closeTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeTx.method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 5. BountyCanceled, and both balances moved to the pot
  await checkSystemEvents(client, 'bounties', { section: 'assets', method: 'Transferred' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('close with usdt events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isOk, `close_bounty failed: ${results[0].toString()}`)

  const events = await client.api.query.system.events()
  const canceled = events.find(({ event }) => client.api.events.bounties.BountyCanceled.is(event))
  assert(canceled && client.api.events.bounties.BountyCanceled.is(canceled.event))
  expect(canceled.event.data.index.toNumber()).toBe(bountyIndex)

  // On some runtimes the collator pot pays the block author in every block, so the bounty's transfer is found by
  // its sender, and plain transfers are left out of the snapshot.
  const nativeTransfers = events.filter(
    ({ event }) => client.api.events.balances.Transfer.is(event) && event.data.from.toHex() === account,
  )
  expect(nativeTransfers).toHaveLength(1)
  assert(client.api.events.balances.Transfer.is(nativeTransfers[0].event))
  expect(nativeTransfers[0].event.data.to.toHex()).toBe(pot)
  expect(nativeTransfers[0].event.data.amount.toBigInt()).toBe(bountyValue)

  const usdtTransfers = events.filter(({ event }) => client.api.events.assets.Transferred.is(event))
  expect(usdtTransfers).toHaveLength(1)
  assert(client.api.events.assets.Transferred.is(usdtTransfers[0].event))
  expect(usdtTransfers[0].event.data.assetId.toNumber()).toBe(usdt)
  expect(usdtTransfers[0].event.data.from.toHex()).toBe(account)
  expect(usdtTransfers[0].event.data.to.toHex()).toBe(pot)
  expect(usdtTransfers[0].event.data.amount.toBigInt()).toBe(sentUsdt)

  // 6. Bounty account empty, pot refilled, invariants hold
  expect(await getBounty(client, bountyIndex)).toBeNull()
  expect((await client.api.query.system.account(account)).data.free.toBigInt()).toBe(0n)
  expect((await client.api.query.assets.account(usdt, account)).isNone).toBe(true)
  expect((await getTreasuryPotFree(client)) - potFreeBefore).toBe(bountyValue)
  const potUsdtAfter = (await client.api.query.assets.account(usdt, pot)).unwrap().balance.toBigInt()
  expect(potUsdtAfter - potUsdtBefore).toBe(sentUsdt)
  await checkBountiesTryState(client)
}

/**
 * A bounty whose curator was proposed but has not accepted can be closed. No deposit is held yet, so the only
 * effect is returning the funds to the treasury pot.
 *
 * 1. Create a `Funded` bounty, and `Treasurer` proposes Bob as curator
 * 2. `Treasurer` closes the bounty
 * 3. Verify the dispatch succeeded, with `BountyCanceled` and a transfer of the whole value to the pot
 * 4. Verify the bounty is removed, the pot grew by the value, and Bob's reserve did not move
 */
async function closeCuratorProposedBountyTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Bob proposed as curator
  const bountyIndex = await createFundedBounty(client, bountyValue, 'Test bounty closed with a proposed curator')
  await dispatchSetupCall(
    client,
    client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, curatorFee),
    {
      Origins: 'Treasurer',
    },
  )
  expect((await getBounty(client, bountyIndex)).status.isCuratorProposed).toBe(true)
  const bobReservedBefore = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved
  const potFreeBefore = await getTreasuryPotFree(client)

  // 2. Treasurer closes
  const closeTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeTx.method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Success, BountyCanceled, value back to the pot
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task|index/ })
    .toMatchSnapshot('close with a proposed curator events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isOk, `close_bounty failed: ${results[0].toString()}`)

  const events = await client.api.query.system.events()
  const canceled = events.find(({ event }) => client.api.events.bounties.BountyCanceled.is(event))
  assert(canceled && client.api.events.bounties.BountyCanceled.is(canceled.event))
  expect(canceled.event.data.index.toNumber()).toBe(bountyIndex)

  // On some runtimes the collator pot pays the block author in every block, so the bounty's transfer is found by
  // its sender, and plain transfers are left out of the snapshot.
  const account = bountyAccount(client, bountyIndex)
  const transfers = events.filter(
    ({ event }) => client.api.events.balances.Transfer.is(event) && event.data.from.toHex() === account,
  )
  expect(transfers).toHaveLength(1)
  assert(client.api.events.balances.Transfer.is(transfers[0].event))
  expect(transfers[0].event.data.to.toHex()).toBe(client.api.consts.treasury.potAccount.toHex())
  expect(transfers[0].event.data.amount.toBigInt()).toBe(bountyValue)

  // 4. Removed, pot refilled, Bob untouched
  expect(await getBounty(client, bountyIndex)).toBeNull()
  expect((await getTreasuryPotFree(client)) - potFreeBefore).toBe(bountyValue)
  const bobReservedAfter = (await client.api.query.system.account(testAccounts.bob.address)).data.reserved
  expect(bobReservedAfter.toBigInt()).toBe(bobReservedBefore.toBigInt())
}

/**
 * A bounty with an active child bounty cannot be closed: `close_bounty` fails with `HasActiveChildBounty`, so a
 * child bounty is never left without its parent.
 *
 * 1. Create an `Active` bounty with Bob as curator
 * 2. Bob adds a child bounty
 * 3. `Treasurer` tries to close the parent bounty
 * 4. Verify the dispatch failed with `HasActiveChildBounty`
 * 5. Verify the parent is still `Active` and still has its child bounty
 */
async function closeBountyWithChildBountyTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Active parent bounty
  const bountyIndex = await createActiveBounty(
    client,
    bountyValue,
    curatorFee,
    testAccounts.bob,
    'Test bounty closed with a child bounty',
  )

  // 2. Child bounty, as setup only
  const childValue = bountyValueMinimum * CURATOR_FEE_MULTIPLIER
  await sendTransaction(
    client.api.tx.childBounties
      .addChildBounty(bountyIndex, childValue, 'Test child bounty')
      .signAsync(testAccounts.bob),
  )
  await client.dev.newBlock()
  const childCount = (await client.api.query.childBounties.parentChildBounties(bountyIndex)).toNumber()
  expect(childCount).toBe(1)

  // 3. Treasurer tries to close the parent
  const closeTx = client.api.tx.bounties.closeBounty(bountyIndex)
  await scheduleInlineCallWithOrigin(
    client,
    closeTx.method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. HasActiveChildBounty
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('close with a child bounty dispatched')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(client.api.errors.bounties.HasActiveChildBounty.is(results[0].asErr.asModule)).toBe(true)

  // 5. Parent still Active with its child
  expect((await getBounty(client, bountyIndex)).status.isActive).toBe(true)
  expect((await client.api.query.childBounties.parentChildBounties(bountyIndex)).toNumber()).toBe(childCount)
}

/**
 * Closing tests: what a close returns to the treasury, and the states it refuses.
 */
export function closingBountyTests(getClient: () => Client<any, any>, testConfig: BountiesTestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'Closing a bounty',
    children: [
      {
        kind: 'test',
        label: 'close a funded bounty that also holds USDT - both swept to the treasury',
        testFn: async () => await closeBountyHoldingUsdtTest(getClient(), testConfig),
      },
      {
        kind: 'test',
        label: 'close in CuratorProposed state - BountyCanceled',
        testFn: async () => await closeCuratorProposedBountyTest(getClient()),
      },
      {
        kind: 'test',
        label: 'close with an active child bounty - HasActiveChildBounty',
        testFn: async () => await closeBountyWithChildBountyTest(getClient()),
      },
    ],
  }
}

/// -------
/// Remaining error paths
/// -------

/**
 * A proposer who cannot reserve the bond cannot propose: `propose_bounty` fails with `InsufficientProposersBalance`
 * and no bounty is recorded.
 *
 * 1. Fund Dave with half of the bond his proposal needs
 * 2. Dave proposes a bounty
 * 3. Verify the call failed with `InsufficientProposersBalance`
 * 4. Verify `BountyCount` is unchanged and Dave reserved nothing
 */
async function proposeWithoutBondTest(client: Client<any, any>) {
  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER
  const description = 'Test bounty the proposer cannot back'
  const bond = currentBond(client, stringToU8a(description).length)

  // 1. Half the bond, which still pays the fee
  await client.dev.setStorage({
    System: { account: [[[testAccounts.dave.address], { providers: 1, data: { free: bond / 2n } }]] },
  })
  const daveBefore = await client.api.query.system.account(testAccounts.dave.address)
  expect(daveBefore.data.free.toBigInt()).toBeLessThan(bond)
  const bountyCountBefore = await getBountyCount(client)

  // 2. Dave proposes
  const proposeTx = client.api.tx.bounties.proposeBounty(bountyValue, description)
  const proposeEvents = await sendTransaction(proposeTx.signAsync(testAccounts.dave))
  await client.dev.newBlock()

  // 3. InsufficientProposersBalance
  await checkEvents(proposeEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('propose without the bond failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  expect(client.api.errors.bounties.InsufficientProposersBalance.is(dispatchError.asModule)).toBe(true)

  // 4. Nothing recorded or reserved
  expect(await getBountyCount(client)).toBe(bountyCountBefore)
  const daveAfter = await client.api.query.system.account(testAccounts.dave.address)
  expect(daveAfter.data.reserved.toBigInt()).toBe(0n)
}

/**
 * The curator fee must be strictly less than the bounty value: `approve_bounty_with_curator` with a fee equal to the
 * value fails with `InvalidFee`.
 *
 * 1. Alice proposes a bounty
 * 2. Dispatch `approve_bounty_with_curator` from `Treasurer`, with a fee equal to the value
 * 3. Verify the dispatch failed with `InvalidFee`
 * 4. Verify the bounty is still `Proposed` with no fee, and not queued
 */
async function approveWithCuratorFeeEqualToValueTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER

  // 1. Proposal
  const bountyIndex = await proposeBounty(
    client,
    testAccounts.alice,
    bountyValue,
    'Test bounty with a fee equal to value',
  )

  // 2. Fee equal to the value
  const approveTx = client.api.tx.bounties.approveBountyWithCurator(bountyIndex, testAccounts.bob.address, bountyValue)
  await scheduleInlineCallWithOrigin(
    client,
    approveTx.method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. InvalidFee
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('approve with curator fee equal to value events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(client.api.errors.bounties.InvalidFee.is(results[0].asErr.asModule)).toBe(true)

  // 4. Still Proposed
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isProposed).toBe(true)
  expect(bounty.fee.toBigInt()).toBe(0n)
  expect(await getBountyApprovals(client)).not.toContain(bountyIndex)
}

/**
 * `propose_curator` enforces the same rule: a fee equal to the bounty value fails with `InvalidFee`.
 *
 * 1. Create a `Funded` bounty
 * 2. Dispatch `propose_curator` from `Treasurer`, with Bob as curator and a fee equal to the value
 * 3. Verify the dispatch failed with `InvalidFee`
 * 4. Verify the bounty is still `Funded` with no fee
 */
async function proposeCuratorFeeEqualToValueTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  const bountyValue = client.api.consts.bounties.bountyValueMinimum.toBigInt() * BOUNTY_MULTIPLIER

  // 1. Funded bounty
  const bountyIndex = await createFundedBounty(client, bountyValue, 'Test bounty with a curator fee equal to value')

  // 2. Fee equal to the value
  const proposeCuratorTx = client.api.tx.bounties.proposeCurator(bountyIndex, testAccounts.bob.address, bountyValue)
  await scheduleInlineCallWithOrigin(
    client,
    proposeCuratorTx.method.toHex(),
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. InvalidFee
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('propose curator fee equal to value events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(client.api.errors.bounties.InvalidFee.is(results[0].asErr.asModule)).toBe(true)

  // 4. Still Funded
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isFunded).toBe(true)
  expect(bounty.fee.toBigInt()).toBe(0n)
}

/**
 * Only the curator can award a bounty: `award_bounty` from any other account fails with `RequireCurator`.
 *
 * 1. Create an `Active` bounty with Bob as curator
 * 2. Charlie tries to award it to himself
 * 3. Verify the call failed with `RequireCurator`
 * 4. Verify the bounty is still `Active`
 */
async function awardByNonCuratorTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Active bounty
  const bountyIndex = await createActiveBounty(
    client,
    bountyValue,
    curatorFee,
    testAccounts.bob,
    'Test bounty awarded by a non-curator',
  )

  // 2. Charlie awards
  const awardTx = client.api.tx.bounties.awardBounty(bountyIndex, testAccounts.charlie.address)
  const awardEvents = await sendTransaction(awardTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 3. RequireCurator
  await checkEvents(awardEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('award by a non-curator failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  expect(client.api.errors.bounties.RequireCurator.is(dispatchError.asModule)).toBe(true)

  // 4. Still Active
  expect((await getBounty(client, bountyIndex)).status.isActive).toBe(true)
}

/**
 * Only the curator can extend a bounty's deadline: `extend_bounty_expiry` from any other account fails with
 * `RequireCurator`.
 *
 * 1. Create an `Active` bounty with Bob as curator
 * 2. Charlie tries to extend its expiry
 * 3. Verify the call failed with `RequireCurator`
 * 4. Verify `update_due` is unchanged
 */
async function extendByNonCuratorTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const curatorFee = bountyValueMinimum * CURATOR_FEE_MULTIPLIER

  // 1. Active bounty
  const bountyIndex = await createActiveBounty(
    client,
    bountyValue,
    curatorFee,
    testAccounts.bob,
    'Test bounty extended by a non-curator',
  )
  const updateDueBefore = (await getBounty(client, bountyIndex)).status.asActive.updateDue.toNumber()

  // 2. Charlie extends
  const extendTx = client.api.tx.bounties.extendBountyExpiry(bountyIndex, 'Not my bounty')
  const extendEvents = await sendTransaction(extendTx.signAsync(testAccounts.charlie))
  await client.dev.newBlock()

  // 3. RequireCurator
  await checkEvents(extendEvents, { section: 'system', method: 'ExtrinsicFailed' })
    .redact({ redactKeys: /weight/ })
    .toMatchSnapshot('extend by a non-curator failed')
  const ev = await extractExtrinsicFailedEvent(client)
  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  expect(client.api.errors.bounties.RequireCurator.is(dispatchError.asModule)).toBe(true)

  // 4. Deadline unchanged
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isActive).toBe(true)
  expect(bounty.status.asActive.updateDue.toNumber()).toBe(updateDueBefore)
}

/**
 * Approved but unfunded bounties wait in `BountyApprovals`, bounded by the treasury's `MaxApprovals`. Once it is full,
 * `approve_bounty` and `approve_bounty_with_curator` both fail with `TooManyQueued`.
 *
 * Every queued bounty is a real proposal approved by `Treasurer`. The scheduler runs a bounded number of tasks per
 * block (`MaxScheduledPerBlock`, 50 on both Asset Hubs), so the approvals are spread over several blocks.
 *
 * 1. Move the treasury's last spend period to now, so no spend period empties the queue during the test
 * 2. Alice proposes enough bounties to fill the queue, plus two, in one `utility.batch_all`
 * 3. `Treasurer` approves bounties until the queue is full
 * 4. Dispatch `approve_bounty` and `approve_bounty_with_curator` for the two extra bounties from `Treasurer`
 * 5. Verify both dispatches failed with `TooManyQueued`
 * 6. Verify the queue is still exactly full, and both extra bounties are still `Proposed`
 */
async function approvalQueueFullTest(client: Client<any, any>) {
  await setupTestAccounts(client, ['alice'])

  const bountyValueMinimum = client.api.consts.bounties.bountyValueMinimum.toBigInt()
  const curatorFee = bountyValueMinimum / 10n
  const maxApprovals = client.api.consts.treasury.maxApprovals.toNumber()

  // 1. No spend period during the test
  const relayNow = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  await client.dev.setStorage({ Treasury: { lastSpendPeriod: relayNow } })

  // 2. Enough proposals to fill the queue, plus two
  const queuedBefore = (await getBountyApprovals(client)).length
  const freeSlots = maxApprovals - queuedBefore
  expect(freeSlots).toBeGreaterThan(0)
  const description = 'Test bounty for a full queue'
  const bond = currentBond(client, stringToU8a(description).length)
  await client.dev.setStorage({
    System: {
      account: [[[testAccounts.alice.address], { providers: 1, data: { free: bond * BigInt(2 * (freeSlots + 2)) } }]],
    },
  })

  const proposals = Array.from({ length: freeSlots + 2 }, () =>
    client.api.tx.bounties.proposeBounty(bountyValueMinimum, description),
  )
  await sendTransaction(client.api.tx.utility.batchAll(proposals).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  const proposedIndices = (await client.api.query.system.events())
    .filter(({ event }) => client.api.events.bounties.BountyProposed.is(event))
    .map(({ event }) => {
      assert(client.api.events.bounties.BountyProposed.is(event))
      return event.data.index.toNumber()
    })
  expect(proposedIndices).toHaveLength(freeSlots + 2)
  const toQueue = proposedIndices.slice(0, freeSlots)
  const [extraIndex, extraWithCuratorIndex] = proposedIndices.slice(freeSlots)

  // 3. Fill the queue. 25 approvals per block stays well inside `MaxScheduledPerBlock` and the scheduler's weight limit.
  const approvalsPerBlock = 25
  for (let start = 0; start < toQueue.length; start += approvalsPerBlock) {
    const chunk = toQueue.slice(start, start + approvalsPerBlock)
    await scheduleInlineCallListWithSameOrigin(
      client,
      chunk.map((index) => client.api.tx.bounties.approveBounty(index).method.toHex()),
      { Origins: 'Treasurer' },
      client.config.properties.schedulerBlockProvider,
    )
    await client.dev.newBlock()

    const results = await schedulerDispatchedResults(client)
    expect(results).toHaveLength(chunk.length)
    for (const result of results) {
      assert(result.isOk, `approve_bounty failed while filling the queue: ${result.toString()}`)
    }
  }
  expect(await getBountyApprovals(client)).toHaveLength(maxApprovals)

  // 4. Two more approvals
  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.bounties.approveBounty(extraIndex).method.toHex(),
      client.api.tx.bounties
        .approveBountyWithCurator(extraWithCuratorIndex, testAccounts.bob.address, curatorFee)
        .method.toHex(),
    ],
    { Origins: 'Treasurer' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 5. TooManyQueued, twice
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' }, 'bounties')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('approvals beyond a full queue events')
  const results = await schedulerDispatchedResults(client)
  expect(results).toHaveLength(2)
  for (const result of results) {
    assert(result.isErr && result.asErr.isModule, `expected a module error, got ${result.toString()}`)
    expect(client.api.errors.bounties.TooManyQueued.is(result.asErr.asModule)).toBe(true)
  }

  // 6. Queue still full, extras still Proposed
  const approvals = await getBountyApprovals(client)
  expect(approvals).toHaveLength(maxApprovals)
  expect(approvals).not.toContain(extraIndex)
  expect(approvals).not.toContain(extraWithCuratorIndex)
  expect((await getBounty(client, extraIndex)).status.isProposed).toBe(true)
  expect((await getBounty(client, extraWithCuratorIndex)).status.isProposed).toBe(true)
}

/**
 * Remaining error path tests: the pallet errors not reached by the groups above.
 */
export function remainingErrorPathTests(getClient: () => Client<any, any>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Remaining error paths',
    children: [
      {
        kind: 'test',
        label: 'propose with too little balance for the bond - InsufficientProposersBalance',
        testFn: async () => await proposeWithoutBondTest(getClient()),
      },
      {
        kind: 'test',
        label: 'approve with curator with a fee equal to the value - InvalidFee',
        testFn: async () => await approveWithCuratorFeeEqualToValueTest(getClient()),
      },
      {
        kind: 'test',
        label: 'propose curator with a fee equal to the value - InvalidFee',
        testFn: async () => await proposeCuratorFeeEqualToValueTest(getClient()),
      },
      {
        kind: 'test',
        label: 'award by a non-curator - RequireCurator',
        testFn: async () => await awardByNonCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'extend expiry by a non-curator - RequireCurator',
        testFn: async () => await extendByNonCuratorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'approve when the approval queue is full - TooManyQueued',
        testFn: async () => await approvalQueueFullTest(getClient()),
      },
    ],
  }
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: BountiesTestConfig): RootTestTree {
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
      allBountySuccessTests(() => client, testConfig),
      allBountyFailureTests(() => client),
      curatorSlashingTests(() => client, testConfig),
      depositPokeTests(() => client),
      originAndSpendLimitTests(() => client, testConfig),
      curatorUnassignByOriginTests(() => client),
      closingBountyTests(() => client, testConfig),
      remainingErrorPathTests(() => client),
    ],
  }
}
