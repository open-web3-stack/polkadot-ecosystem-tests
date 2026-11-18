/**
 * E2E tests for `pallet_referenda` on the Asset Hubs.
 *
 * A signed account submits a proposal on the track its dispatch origin maps to, reserving the
 * submission deposit. Once anyone places the track's decision deposit and the prepare period has
 * passed, the referendum enters the deciding phase, where conviction votes are measured against the
 * track's approval and support curves. The pallet moves each referendum along with scheduler alarms
 * it sets on itself (`nudge_referendum`, `one_fewer_deciding`, both dispatched as Root). Governance
 * can end an ongoing referendum early: `cancel` keeps the deposits refundable, `kill` slashes them.
 *
 * Time units: on the Asset Hubs the pallet's block provider is the relay chain, so `submitted`,
 * `deciding.since`, alarms and the block recorded in a finished referendum are relay block numbers.
 * Every Asset Hub block moves the relay number forward by several blocks. Calls the scheduler
 * dispatches run in `on_initialize`, before the block's relay parent is known, so they see the
 * previous block's relay number, while extrinsics see the current one.
 *
 * Fork caveats: the fork carries live referenda, whose alarms may fire in the blocks a test builds.
 * Event checks therefore match the referendum under test by index.
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client, RootTestTree } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import { compactAddLength, stringToHex, stringToU8a, u8aConcat } from '@polkadot/util'
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import {
  blockProviderOffset,
  check,
  checkSystemEvents,
  getBlockNumber,
  getFreeFunds,
  getReservedFunds,
  nextSchedulableBlockNum,
  scheduleCallListWithOrigin,
  scheduleInlineCallListWithSameOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import { setupBalances } from './setup.js'

/// -------
/// Constants
/// -------

/**
 * Track most tests run on: `small_tipper`.
 *
 * It exists on both Asset Hubs, has the shortest prepare period (10 relay blocks) and the smallest
 * decision deposit, so a referendum on it reaches the deciding phase through the real scheduler
 * alarm within a few blocks.
 */
const SMALL_TIPPER_TRACK = 30

/**
 * Proposal origin that the runtime's `track_for` maps to `SMALL_TIPPER_TRACK`.
 *
 * Typed as `any` because the API augmentation describes a generic runtime's origin enum, which
 * lacks the Asset Hubs' custom `Origins` variant.
 */
const SMALL_TIPPER_ORIGIN: any = { Origins: 'SmallTipper' }

/**
 * Balance each signer is given, as a multiple of the submission deposit.
 *
 * Covers every deposit and fee a signer pays on the `small_tipper` track, with room to spare.
 */
const FUNDS_IN_SUBMISSION_DEPOSITS = 1_000n

/**
 * Relay blocks of `small_tipper`'s decision period left when a test moves `deciding.since` back.
 *
 * That close to the end, the track's support curve asks for under 0.001% of issuance, so one modest
 * vote passes. The margin is still far larger than the relay blocks a test builds afterwards, so
 * the decision period does not run out, which would reject the referendum instead.
 */
const DECISION_PERIOD_LEFT = 400

/// -------
/// Types
/// -------

/**
 * Where the runtime's `pallet_referenda::Config::Slash` handler sends deposits slashed by `kill`.
 *
 * - `dapStaging`: `pallet_dap::DapLegacyAdapter`, which credits the DAP staging account.
 * - `treasury`: `pallet_treasury`, which credits the treasury pot and emits `treasury.Deposit`.
 */
export type ReferendaSlashDestination = 'dapStaging' | 'treasury'

export interface ReferendaTestConfig extends TestConfig {
  /** Where `kill` sends slashed deposits on this chain. */
  slashDestination: ReferendaSlashDestination
}

/// -------
/// Helpers
/// -------

/** Give each account `FUNDS_IN_SUBMISSION_DEPOSITS` submission deposits of free balance, with nothing reserved. */
async function fundAccounts(client: Client<any, any>, ...accounts: KeyringPair[]) {
  const amount = client.api.consts.referenda.submissionDeposit.toBigInt() * FUNDS_IN_SUBMISSION_DEPOSITS
  await setupBalances(
    client,
    accounts.map(({ address }) => ({ address, amount })),
  )
}

/**
 * A small inline proposal.
 *
 * No test in this suite lets a referendum pass, so the proposal is never enacted.
 */
function remarkProposal(client: Client<any, any>) {
  return { Inline: client.api.tx.system.remark('referenda e2e').method.toHex() }
}

/** An account's address in the chain's SS58 format, for comparing against account ids in events and storage. */
function addressOf(client: Client<any, any>, account: KeyringPair): string {
  return encodeAddress(account.address, client.config.properties.addressEncoding)
}

/**
 * Address of the account that `kill` credits with slashed deposits, in the chain's SS58 format.
 *
 * - `dapStaging`: the sub-account `staging` of `sp_dap::DAP_PALLET_ID` (`dap/buff`), as
 *   `pallet_dap::Pallet::staging_account` derives it.
 * - `treasury`: the treasury's pallet account, from its `PalletId` constant.
 *
 * A pallet account is `modl`, the 8-byte pallet id and any SCALE-encoded sub-account seed,
 * padded with zeros to 32 bytes.
 */
function slashDestinationAddress(client: Client<any, any>, destination: ReferendaSlashDestination): string {
  const seed =
    destination === 'dapStaging'
      ? u8aConcat(stringToU8a('modl'), stringToU8a('dap/buff'), compactAddLength(stringToU8a('staging')))
      : u8aConcat(stringToU8a('modl'), client.api.consts.treasury.palletId.toU8a())
  return encodeAddress(u8aConcat(seed, new Uint8Array(32 - seed.length)), client.config.properties.addressEncoding)
}

/**
 * Setup: `account` notes `text` as a preimage, as off-chain metadata for a referendum would be, and
 * the preimage's hash is returned.
 */
async function notePreimage(client: Client<any, any>, account: KeyringPair, text: string): Promise<string> {
  const bytes = stringToHex(text)
  await sendTransaction(client.api.tx.preimage.notePreimage(bytes).signAsync(account))
  await client.dev.newBlock()

  const hash = blake2AsHex(bytes, 256)
  expect((await client.api.query.preimage.requestStatusFor(hash)).isSome, 'setup: the preimage was not noted').toBe(
    true,
  )
  return hash
}

/**
 * Setup: `submitter` sets the noted preimage `hash` as referendum `index`'s metadata.
 *
 * Asserts the metadata was set, so a later failure in the test cannot come from it.
 */
async function setMetadata(client: Client<any, any>, submitter: KeyringPair, index: number, hash: string) {
  await sendTransaction(client.api.tx.referenda.setMetadata(index, hash).signAsync(submitter))
  await client.dev.newBlock()

  expect(await referendumEvents(client, index, 'MetadataSet'), 'setup: the metadata was not set').toHaveLength(1)
}

/**
 * Assert that the head block holds exactly one failed extrinsic, and that it failed with the named
 * module error.
 *
 * The error is looked up in metadata first, so a renamed error fails the test instead of matching
 * nothing.
 */
async function expectExtrinsicError(
  client: Client<any, any>,
  pallet: 'referenda' | 'balances',
  errorName: string,
): Promise<void> {
  const events = await client.api.query.system.events()
  const failures = events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failures, 'expected exactly one ExtrinsicFailed event').toHaveLength(1)

  const failure = failures[0].event
  assert(client.api.events.system.ExtrinsicFailed.is(failure))
  const { dispatchError } = failure.data
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)

  const palletErrors = (client.api.errors as any)[pallet]
  assert(palletErrors?.[errorName], `runtime has no ${pallet} error named ${errorName}`)
  expect(palletErrors[errorName].is(dispatchError.asModule), `expected ${pallet}.${errorName}`).toBe(true)
}

/** The runtime's parameters for track `id`, from the `tracks` constant. */
function trackInfo(client: Client<any, any>, id: number) {
  const entry = client.api.consts.referenda.tracks.find(([trackId]) => trackId.toNumber() === id)
  assert(entry, `runtime has no track ${id}`)
  return entry[1]
}

/** Referendum `index`'s status, asserting that it exists and is ongoing. */
async function ongoingStatus(client: Client<any, any>, index: number) {
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome, `referendum ${index} does not exist`)
  assert(info.unwrap().isOngoing, `referendum ${index} is not ongoing`)
  return info.unwrap().asOngoing
}

/**
 * The head block's `referenda` events of the given kinds that carry referendum `index`, in block
 * order.
 *
 * Live referenda on the fork can emit the same kinds of events in the same block, so whole-event
 * snapshots of the referendum under test are taken from this list.
 */
async function referendumEvents(client: Client<any, any>, index: number, ...methods: string[]) {
  const events = await client.api.query.system.events()
  return events.filter(
    ({ event }) =>
      event.section === 'referenda' &&
      methods.includes(event.method) &&
      (event.data as any).index?.toNumber() === index,
  )
}

/**
 * Setup: `submitter` submits a referendum with `remarkProposal` under `proposalOrigin`, and the
 * new referendum's index is returned.
 *
 * Asserts the submission succeeded, so a later failure in the test cannot come from it.
 */
async function submitReferendum(
  client: Client<any, any>,
  submitter: KeyringPair,
  proposalOrigin: any = SMALL_TIPPER_ORIGIN,
): Promise<number> {
  await sendTransaction(
    client.api.tx.referenda.submit(proposalOrigin, remarkProposal(client), { After: 1 }).signAsync(submitter),
  )
  await client.dev.newBlock()

  // Only an extrinsic can submit a referendum, and this block holds just this one.
  const events = await client.api.query.system.events()
  const submitted = events.filter(({ event }) => client.api.events.referenda.Submitted.is(event))
  expect(submitted, 'setup: the submission failed').toHaveLength(1)
  const event = submitted[0].event
  assert(client.api.events.referenda.Submitted.is(event))
  return event.data.index.toNumber()
}

/**
 * Setup: `depositor` places the decision deposit for referendum `index`.
 *
 * Asserts the deposit was placed, so a later failure in the test cannot come from it.
 */
async function placeDecisionDeposit(client: Client<any, any>, depositor: KeyringPair, index: number) {
  await sendTransaction(client.api.tx.referenda.placeDecisionDeposit(index).signAsync(depositor))
  await client.dev.newBlock()

  const placed = await referendumEvents(client, index, 'DecisionDepositPlaced')
  expect(placed, 'setup: placing the decision deposit failed').toHaveLength(1)
}

/**
 * Setup: rewrite referendum `index`'s ongoing status with `changes` applied.
 *
 * `setStorage` replaces the whole value, so every other field is written back as it was.
 */
async function rewriteOngoing(client: Client<any, any>, index: number, changes: Record<string, unknown>) {
  const status = await ongoingStatus(client, index)
  await client.dev.setStorage({
    Referenda: {
      ReferendumInfoFor: [
        [
          [index],
          {
            Ongoing: {
              track: status.track,
              origin: status.origin,
              proposal: status.proposal,
              enactment: status.enactment,
              submitted: status.submitted,
              submissionDeposit: status.submissionDeposit,
              decisionDeposit: status.decisionDeposit,
              deciding: status.deciding,
              tally: status.tally,
              inQueue: status.inQueue,
              alarm: status.alarm,
              ...changes,
            },
          },
        ],
      ],
    },
  })
}

/**
 * Build blocks until the scheduler has serviced its agenda at relay block `relayBlock`, and return
 * the relay number the scheduler saw in the last block built.
 *
 * The scheduler runs in `on_initialize`, before the block's relay parent is known, so it reads the
 * previous block's relay number. A task at `relayBlock` therefore runs in the first block built
 * after `lastRelayChainBlockNumber` reaches `relayBlock`.
 */
async function buildBlocksUntilScheduled(client: Client<any, any>, relayBlock: number): Promise<number> {
  const { schedulerBlockProvider } = client.config.properties
  const relayBlocksPerBlock = blockProviderOffset(
    schedulerBlockProvider,
    (client.config.properties as any).relayBlocksPerParaBlock,
  )
  const relayNow = await getBlockNumber(client.api, schedulerBlockProvider)
  const blocksUntilReached = Math.max(0, Math.ceil((relayBlock - relayNow) / relayBlocksPerBlock))

  await client.dev.newBlock({ count: blocksUntilReached + 1 })
  return relayNow + blocksUntilReached * relayBlocksPerBlock
}

/**
 * The head block's `scheduler.Dispatched` records for tasks from the agenda at `agendaBlock`, in
 * agenda order.
 *
 * Injected calls go into the agenda at the block the scheduler services next. Matching on that
 * block keeps out the alarms of live referenda, which the same block may also dispatch.
 */
async function dispatchedFromAgenda(client: Client<any, any>, agendaBlock: number) {
  const events = await client.api.query.system.events()
  return events
    .filter(
      ({ event }) => client.api.events.scheduler.Dispatched.is(event) && event.data.task[0].toNumber() === agendaBlock,
    )
    .sort((a, b) => (a.event.data as any).task[1].toNumber() - (b.event.data as any).task[1].toNumber())
}

/**
 * Assert that a `scheduler.Dispatched` record carries a failed result with the named `referenda`
 * error.
 *
 * The error is looked up in metadata first, so a renamed error fails the test instead of matching
 * nothing.
 */
function expectDispatchedError(client: Client<any, any>, record: { event: any }, errorName: string) {
  const { event } = record
  assert(client.api.events.scheduler.Dispatched.is(event))
  assert(event.data.result.isErr, 'expected the dispatch to fail')
  const dispatchError = event.data.result.asErr
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)

  const referendaErrors = client.api.errors.referenda as any
  assert(referendaErrors[errorName], `runtime has no referenda error named ${errorName}`)
  expect(referendaErrors[errorName].is(dispatchError.asModule), `expected referenda.${errorName}`).toBe(true)
}

/**
 * Setup: dispatch `call` as Root through the scheduler in the next block.
 *
 * Asserts the dispatch succeeded, so a later failure in the test cannot come from it.
 */
async function dispatchAsRoot(client: Client<any, any>, call: { method: { toHex(): string } }) {
  const { schedulerBlockProvider } = client.config.properties
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    call.method.toHex() as `0x${string}`,
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched, 'setup: the Root call was not dispatched').toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk, 'setup: the Root call failed').toBe(true)
}

/// -------
/// Tests: submission
/// -------

/**
 * A signed account submits a referendum on the `small_tipper` track.
 *
 * The submission deposit is reserved from the submitter, and the referendum is stored as ongoing
 * with no decision deposit. The pallet also schedules its own timeout alarm, a `nudge_referendum`
 * call dispatched as Root `UndecidingTimeout` blocks after submission. Both `submitted` and the
 * alarm are relay block numbers, since the relay chain is the pallet's block provider here.
 *
 * 1. Fund the submitter and record the referendum count
 * 2. Submit a referendum on `small_tipper`
 * 3. Verify the `Submitted` and `Reserved` events
 * 4. Verify the stored referendum and the reserved deposit
 * 5. Verify the timeout alarm sits in the scheduler agenda at the relay block it names
 */
async function submitReservesDepositAndSetsAlarm(client: Client<any, any>) {
  const { alice } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const undecidingTimeout = client.api.consts.referenda.undecidingTimeout.toNumber()
  const alarmInterval = client.api.consts.referenda.alarmInterval.toNumber()
  const proposal = remarkProposal(client)

  // 1. Fund the submitter and record the referendum count
  await fundAccounts(client, alice)
  const countBefore = (await client.api.query.referenda.referendumCount()).toNumber()

  // 2. Submit on `small_tipper`
  await sendTransaction(client.api.tx.referenda.submit(SMALL_TIPPER_ORIGIN, proposal, { After: 1 }).signAsync(alice))
  await client.dev.newBlock()

  // 3. `Submitted` and `Reserved` events
  await checkSystemEvents(
    client,
    { section: 'referenda', method: 'Submitted' },
    { section: 'balances', method: 'Reserved' },
  )
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('submit: Submitted and Reserved events')

  const events = await client.api.query.system.events()
  const submittedEvents = events.filter(({ event }) => client.api.events.referenda.Submitted.is(event))
  expect(submittedEvents).toHaveLength(1)
  const submitted = submittedEvents[0].event
  assert(client.api.events.referenda.Submitted.is(submitted))
  const index = submitted.data.index.toNumber()
  expect(index, 'the new referendum takes the next free index').toBe(countBefore)
  expect(submitted.data.track.toNumber()).toBe(SMALL_TIPPER_TRACK)
  assert(submitted.data.proposal.isInline)
  expect(submitted.data.proposal.asInline.toHex()).toBe(proposal.Inline)

  const reservedEvents = events.filter(
    ({ event }) =>
      client.api.events.balances.Reserved.is(event) && event.data.who.toString() === addressOf(client, alice),
  )
  expect(reservedEvents).toHaveLength(1)
  const reserved = reservedEvents[0].event
  assert(client.api.events.balances.Reserved.is(reserved))
  expect(reserved.data.amount.toBigInt()).toBe(submissionDeposit)

  // 4. Stored referendum and reserved deposit
  expect((await client.api.query.referenda.referendumCount()).toNumber()).toBe(countBefore + 1)

  const relayNow = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  const status = await ongoingStatus(client, index)

  expect(status.track.toNumber()).toBe(SMALL_TIPPER_TRACK)
  expect(status.origin.toJSON()).toEqual({ origins: 'SmallTipper' })
  assert(status.proposal.isInline)
  expect(status.proposal.asInline.toHex()).toBe(proposal.Inline)
  expect(status.submitted.toNumber(), '`submitted` is the relay block of the submission').toBe(relayNow)
  expect(status.submissionDeposit.who.toString()).toBe(addressOf(client, alice))
  expect(status.submissionDeposit.amount.toBigInt()).toBe(submissionDeposit)
  expect(status.decisionDeposit.isNone).toBe(true)
  expect(status.deciding.isNone).toBe(true)
  expect(status.inQueue.isFalse).toBe(true)
  expect(status.tally.ayes.toBigInt()).toBe(0n)
  expect(status.tally.nays.toBigInt()).toBe(0n)
  expect(status.tally.support.toBigInt()).toBe(0n)

  expect(await getReservedFunds(client, alice.address)).toBe(submissionDeposit)

  // 5. Timeout alarm in the scheduler agenda, rounded up to a multiple of `AlarmInterval`
  const expectedAlarm = Math.ceil((relayNow + undecidingTimeout) / alarmInterval) * alarmInterval
  assert(status.alarm.isSome)
  const [alarmBlock, [agendaBlock, agendaIndex]] = status.alarm.unwrap()
  expect(alarmBlock.toNumber()).toBe(expectedAlarm)
  expect(agendaBlock.toNumber()).toBe(expectedAlarm)

  const agenda = await client.api.query.scheduler.agenda(expectedAlarm)
  const task = agenda[agendaIndex.toNumber()]
  assert(task?.isSome, 'the timeout alarm is missing from the scheduler agenda')
  const scheduled = task.unwrap()
  assert(scheduled.call.isInline)
  expect(scheduled.call.asInline.toHex()).toBe(client.api.tx.referenda.nudgeReferendum(index).method.toHex())
  expect(scheduled.origin.toJSON()).toEqual({ system: { root: null } })
}

/**
 * A proposal whose dispatch origin maps to no track is rejected.
 *
 * The runtime's `track_for` gives a track to Root and to the custom governance origins only. With
 * a signed account as the proposal's origin, `submit` fails with `NoTrack` before any deposit is
 * taken.
 *
 * 1. Fund the submitter and record the referendum count
 * 2. Submit a proposal whose dispatch origin is a signed account
 * 3. Verify the call failed with `NoTrack`
 * 4. Verify no referendum was stored and nothing was reserved
 */
async function submitWithoutTrackFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()

  // 1. Fund the submitter, with enough for the deposit so funds cannot be the cause
  await fundAccounts(client, alice)
  expect(await getFreeFunds(client, alice.address)).toBeGreaterThan(submissionDeposit)
  const countBefore = (await client.api.query.referenda.referendumCount()).toNumber()

  // 2. Submit with a signed proposal origin
  const proposalOrigin = { system: { Signed: bob.address } }
  await sendTransaction(
    client.api.tx.referenda.submit(proposalOrigin, remarkProposal(client), { After: 1 }).signAsync(alice),
  )
  await client.dev.newBlock()

  // 3. `NoTrack`
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'no track: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'NoTrack')

  // 4. Nothing stored or reserved
  expect((await client.api.query.referenda.referendumCount()).toNumber()).toBe(countBefore)
  expect(await getReservedFunds(client, alice.address)).toBe(0n)
}

/**
 * A lookup proposal whose length disagrees with its stored preimage is rejected.
 *
 * When the preimage is already noted, `submit` compares its stored length with the length the
 * lookup claims. A referendum therefore cannot point at a preimage that would later fail to
 * load at enactment.
 *
 * 1. Fund the submitter and note a preimage
 * 2. Verify the preimage is stored with its real length
 * 3. Submit a lookup proposal for that hash, with the length off by one
 * 4. Verify the call failed with `PreimageStoredWithDifferentLength`
 * 5. Verify no referendum was stored and the submission reserved nothing
 */
async function submitLookupWithWrongLengthFails(client: Client<any, any>) {
  const { alice } = testAccounts
  const encodedCall = client.api.tx.system.remark('referenda e2e lookup').method.toHex()
  const hash = blake2AsHex(encodedCall, 256)
  const len = (encodedCall.length - 2) / 2

  // 1. Fund the submitter and note the preimage
  await fundAccounts(client, alice)
  await sendTransaction(client.api.tx.preimage.notePreimage(encodedCall).signAsync(alice))
  await client.dev.newBlock()

  // 2. The preimage is stored with its real length
  const requestStatus = await client.api.query.preimage.requestStatusFor(hash)
  assert(requestStatus.isSome, 'the preimage was not noted')
  assert(requestStatus.unwrap().isUnrequested)
  expect(requestStatus.unwrap().asUnrequested.len.toNumber()).toBe(len)

  const countBefore = (await client.api.query.referenda.referendumCount()).toNumber()
  const reservedBefore = await getReservedFunds(client, alice.address)

  // 3. Submit a lookup with the wrong length
  await sendTransaction(
    client.api.tx.referenda
      .submit(SMALL_TIPPER_ORIGIN, { Lookup: { hash, len: len + 1 } }, { After: 1 })
      .signAsync(alice),
  )
  await client.dev.newBlock()

  // 4. `PreimageStoredWithDifferentLength`
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'lookup length: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'PreimageStoredWithDifferentLength')

  // 5. Nothing stored, nothing more reserved
  expect((await client.api.query.referenda.referendumCount()).toNumber()).toBe(countBefore)
  expect(await getReservedFunds(client, alice.address)).toBe(reservedBefore)
}

/**
 * A submitter who cannot cover the submission deposit is rejected.
 *
 * The deposit is reserved from free balance. With less free balance than `SubmissionDeposit`, the
 * reserve, and with it the submission, fails with the balances pallet's `InsufficientBalance`.
 *
 * 1. Fund the submitter with half the submission deposit
 * 2. Submit a referendum
 * 3. Verify the call failed with `InsufficientBalance`
 * 4. Verify no referendum was stored and nothing was reserved
 */
async function submitWithoutDepositFails(client: Client<any, any>) {
  const { alice } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()

  // 1. Fund the submitter with half the deposit
  await setupBalances(client, [{ address: alice.address, amount: submissionDeposit / 2n }])
  const countBefore = (await client.api.query.referenda.referendumCount()).toNumber()

  // 2. Submit
  await sendTransaction(
    client.api.tx.referenda.submit(SMALL_TIPPER_ORIGIN, remarkProposal(client), { After: 1 }).signAsync(alice),
  )
  await client.dev.newBlock()

  // 3. `InsufficientBalance`, with the free balance confirmed below the deposit
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'insufficient submission deposit: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'balances', 'InsufficientBalance')
  expect(await getFreeFunds(client, alice.address)).toBeLessThan(submissionDeposit)

  // 4. Nothing stored or reserved
  expect((await client.api.query.referenda.referendumCount()).toNumber()).toBe(countBefore)
  expect(await getReservedFunds(client, alice.address)).toBe(0n)
}

/// -------
/// Tests: decision deposit
/// -------

/**
 * Placing the decision deposit starts the prepare period, and the referendum begins deciding once
 * it ends.
 *
 * The deposit is the track's `decisionDeposit`, reserved from the depositor, and placing it moves
 * the referendum's alarm to the end of the prepare period. The scheduler then dispatches the
 * pallet's `nudge_referendum` alarm, which takes a deciding slot on the track and emits
 * `DecisionStarted`. Nothing is injected: `small_tipper`'s prepare period lasts a few Asset Hub
 * blocks.
 *
 * The scheduler runs in `on_initialize`, before the block's relay parent is known, so it reads the
 * relay number of the previous block. The alarm therefore fires one block after the relay chain
 * passes it, and `deciding.since` is that previous relay number.
 *
 * 1. Fund the submitter and the depositor, and submit a referendum
 * 2. Place the decision deposit
 * 3. Verify the `DecisionDepositPlaced` event, the reserved deposit and the moved alarm
 * 4. Build blocks until the relay chain passes the end of the prepare period, and verify the
 *    referendum is still preparing
 * 5. Build one more block, and verify the alarm dispatched and emitted `DecisionStarted`
 * 6. Verify the referendum is deciding from the alarm's relay block and holds a deciding slot
 */
async function placeDecisionDepositStartsDeciding(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const track = trackInfo(client, SMALL_TIPPER_TRACK)
  const decisionDeposit = track.decisionDeposit.toBigInt()
  const alarmInterval = client.api.consts.referenda.alarmInterval.toNumber()
  const { schedulerBlockProvider } = client.config.properties
  const relayBlocksPerBlock = blockProviderOffset(
    schedulerBlockProvider,
    (client.config.properties as any).relayBlocksPerParaBlock,
  )

  // 1. Fund both accounts and submit
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  const decidingCountBefore = (await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()

  // 2. Place the decision deposit
  await sendTransaction(client.api.tx.referenda.placeDecisionDeposit(index).signAsync(bob))
  await client.dev.newBlock()

  // 3. `DecisionDepositPlaced`, reserved deposit, alarm moved to the end of the prepare period
  await checkSystemEvents(
    client,
    { section: 'referenda', method: 'DecisionDepositPlaced' },
    { section: 'balances', method: 'Reserved' },
  )
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('deposit: DecisionDepositPlaced and Reserved events')

  const placedRecords = await referendumEvents(client, index, 'DecisionDepositPlaced')
  expect(placedRecords).toHaveLength(1)
  const placed = placedRecords[0].event
  assert(client.api.events.referenda.DecisionDepositPlaced.is(placed))
  expect(placed.data.who.toString()).toBe(addressOf(client, bob))
  expect(placed.data.amount.toBigInt(), "the deposit is the track's decision deposit").toBe(decisionDeposit)
  expect(await getReservedFunds(client, bob.address)).toBe(decisionDeposit)

  const preparing = await ongoingStatus(client, index)
  assert(preparing.decisionDeposit.isSome)
  expect(preparing.decisionDeposit.unwrap().who.toString()).toBe(addressOf(client, bob))
  expect(preparing.decisionDeposit.unwrap().amount.toBigInt()).toBe(decisionDeposit)
  expect(preparing.deciding.isNone).toBe(true)

  const prepareEnd =
    Math.ceil((preparing.submitted.toNumber() + track.preparePeriod.toNumber()) / alarmInterval) * alarmInterval
  assert(preparing.alarm.isSome)
  const [alarmBlock, [, alarmAgendaIndex]] = preparing.alarm.unwrap()
  expect(alarmBlock.toNumber(), 'the alarm moves to the end of the prepare period').toBe(prepareEnd)

  // 4. Once the relay chain passes the end of the prepare period, the referendum is still preparing
  const relayAfterDeposit = await getBlockNumber(client.api, schedulerBlockProvider)
  const blocksToPrepareEnd = Math.ceil((prepareEnd - relayAfterDeposit) / relayBlocksPerBlock)
  await client.dev.newBlock({ count: blocksToPrepareEnd })

  const relayBeforeAlarm = await getBlockNumber(client.api, schedulerBlockProvider)
  expect(relayBeforeAlarm, 'each block advances the relay chain by a fixed step').toBe(
    relayAfterDeposit + blocksToPrepareEnd * relayBlocksPerBlock,
  )
  expect(relayBeforeAlarm).toBeGreaterThanOrEqual(prepareEnd)
  expect((await ongoingStatus(client, index)).deciding.isNone).toBe(true)
  expect(await referendumEvents(client, index, 'DecisionStarted')).toHaveLength(0)

  // 5. The next block's scheduler sees that relay number, dispatches the alarm, and deciding starts
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const alarmDispatched = events.filter(
    ({ event }) =>
      client.api.events.scheduler.Dispatched.is(event) &&
      event.data.task[0].toNumber() === prepareEnd &&
      event.data.task[1].toNumber() === alarmAgendaIndex.toNumber(),
  )
  expect(alarmDispatched, 'the prepare alarm was dispatched once').toHaveLength(1)
  const dispatched = alarmDispatched[0].event
  assert(client.api.events.scheduler.Dispatched.is(dispatched))
  expect(dispatched.data.result.isOk).toBe(true)

  const startedRecords = await referendumEvents(client, index, 'DecisionStarted')
  expect(startedRecords).toHaveLength(1)
  await check([...alarmDispatched, ...startedRecords])
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('prepare period end: alarm Dispatched and DecisionStarted events')

  const started = startedRecords[0].event
  assert(client.api.events.referenda.DecisionStarted.is(started))
  expect(started.data.track.toNumber()).toBe(SMALL_TIPPER_TRACK)
  assert(started.data.proposal.isInline)
  expect(started.data.proposal.asInline.toHex()).toBe(remarkProposal(client).Inline)
  expect(started.data.tally.ayes.toBigInt()).toBe(0n)
  expect(started.data.tally.nays.toBigInt()).toBe(0n)
  expect(started.data.tally.support.toBigInt()).toBe(0n)

  // 6. Deciding from the relay number the scheduler saw, holding a slot
  const deciding = await ongoingStatus(client, index)
  assert(deciding.deciding.isSome)
  expect(deciding.deciding.unwrap().since.toNumber()).toBe(relayBeforeAlarm)
  expect(deciding.deciding.unwrap().confirming.isNone, 'no votes, so not confirming').toBe(true)
  expect((await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()).toBe(decidingCountBefore + 1)
}

/**
 * A second decision deposit is rejected.
 *
 * Each referendum takes one decision deposit. Once it is placed, another account's attempt fails
 * with `HasDeposit`, and the first deposit stays in place.
 *
 * 1. Fund three accounts, submit a referendum, and place its decision deposit
 * 2. Place the decision deposit again from another account
 * 3. Verify the call failed with `HasDeposit`
 * 4. Verify the deposit is still the first depositor's and the second account reserved nothing
 */
async function placeDecisionDepositTwiceFails(client: Client<any, any>) {
  const { alice, bob, charlie } = testAccounts
  const decisionDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()

  // 1. Submit and place the first deposit
  await fundAccounts(client, alice, bob, charlie)
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)

  // 2. A second deposit from another account
  await sendTransaction(client.api.tx.referenda.placeDecisionDeposit(index).signAsync(charlie))
  await client.dev.newBlock()

  // 3. `HasDeposit`
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'second deposit: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'HasDeposit')

  // 4. The first deposit stands
  const status = await ongoingStatus(client, index)
  assert(status.decisionDeposit.isSome)
  expect(status.decisionDeposit.unwrap().who.toString()).toBe(addressOf(client, bob))
  expect(status.decisionDeposit.unwrap().amount.toBigInt()).toBe(decisionDeposit)
  expect(await getReservedFunds(client, bob.address)).toBe(decisionDeposit)
  expect(await getReservedFunds(client, charlie.address)).toBe(0n)
}

/**
 * A depositor who cannot cover the track's decision deposit is rejected.
 *
 * Decision deposits are set per track. The depositor here holds more than `small_tipper`'s deposit
 * but less than the `root` track's, so placing the deposit on a `root` referendum fails with the
 * balances pallet's `InsufficientBalance`.
 *
 * 1. Fund the submitter, and fund the depositor with half the `root` track's decision deposit
 * 2. Submit a referendum on the `root` track
 * 3. Place the decision deposit
 * 4. Verify the call failed with `InsufficientBalance`
 * 5. Verify no decision deposit was recorded or reserved
 */
async function placeDecisionDepositWithoutFundsFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const rootDeposit = trackInfo(client, 0).decisionDeposit.toBigInt()
  const tipperDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()

  // 1. Fund the submitter, and the depositor with half the `root` deposit
  await fundAccounts(client, alice)
  await setupBalances(client, [{ address: bob.address, amount: rootDeposit / 2n }])
  expect(rootDeposit / 2n, "the depositor could cover `small_tipper`'s deposit").toBeGreaterThan(tipperDeposit)

  // 2. Submit on the `root` track
  const index = await submitReferendum(client, alice, { system: 'Root' })
  expect((await ongoingStatus(client, index)).track.toNumber()).toBe(0)

  // 3. Place the decision deposit
  await sendTransaction(client.api.tx.referenda.placeDecisionDeposit(index).signAsync(bob))
  await client.dev.newBlock()

  // 4. `InsufficientBalance`, with the free balance confirmed below the deposit
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'insufficient decision deposit: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'balances', 'InsufficientBalance')
  expect(await getFreeFunds(client, bob.address)).toBeLessThan(rootDeposit)

  // 5. Nothing recorded or reserved
  expect((await ongoingStatus(client, index)).decisionDeposit.isNone).toBe(true)
  expect(await getReservedFunds(client, bob.address)).toBe(0n)
}

/// -------
/// Tests: deciding slots
/// -------

/**
 * On a full track, a prepared referendum waits in the track's queue, and Root's
 * `one_fewer_deciding` starts it.
 *
 * Each track lets at most `max_deciding` referenda decide at once. The test raises
 * `small_tipper`'s deciding count to that limit by a storage edit, since filling every slot with
 * real referenda is impractical. At the end of the prepare period the alarm then queues the
 * referendum instead of starting it. `one_fewer_deciding` is the call the pallet schedules when a
 * slot frees up. Dispatched as Root, it takes the best queued referendum and starts deciding it,
 * leaving the count alone because the freed slot is reused.
 *
 * 1. Fund the accounts, submit a referendum, and raise the track's deciding count to its limit
 * 2. Place the decision deposit
 * 3. Build blocks until the prepare alarm fires, and verify it queued the referendum
 * 4. Dispatch `one_fewer_deciding` for the track as Root
 * 5. Verify the dispatch succeeded and the referendum started deciding
 * 6. Verify the queue is empty and the deciding count is unchanged
 */
async function oneFewerDecidingStartsQueuedReferendum(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const maxDeciding = trackInfo(client, SMALL_TIPPER_TRACK).maxDeciding.toNumber()
  const { schedulerBlockProvider } = client.config.properties

  // 1. Submit, then fill the track's deciding slots
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  await client.dev.setStorage({ Referenda: { DecidingCount: [[[SMALL_TIPPER_TRACK], maxDeciding]] } })
  expect((await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()).toBe(maxDeciding)
  expect(await client.api.query.referenda.trackQueue(SMALL_TIPPER_TRACK)).toHaveLength(0)

  // 2. Place the decision deposit
  await placeDecisionDeposit(client, bob, index)

  // 3. The prepare alarm queues the referendum
  const preparing = await ongoingStatus(client, index)
  assert(preparing.alarm.isSome)
  const prepareEnd = preparing.alarm.unwrap()[0].toNumber()
  await buildBlocksUntilScheduled(client, prepareEnd)

  const alarmDispatched = await dispatchedFromAgenda(client, prepareEnd)
  expect(alarmDispatched.length, 'the prepare alarm was dispatched').toBeGreaterThanOrEqual(1)
  expect(await referendumEvents(client, index, 'DecisionStarted')).toHaveLength(0)

  const queued = await ongoingStatus(client, index)
  expect(queued.inQueue.isTrue).toBe(true)
  expect(queued.deciding.isNone).toBe(true)
  expect(queued.alarm.isNone, 'a queued referendum waits for a slot, not an alarm').toBe(true)
  const queue = await client.api.query.referenda.trackQueue(SMALL_TIPPER_TRACK)
  expect(queue.map(([queuedIndex, ayes]) => [queuedIndex.toNumber(), ayes.toBigInt()])).toEqual([[index, 0n]])

  // 4. `one_fewer_deciding` as Root
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.oneFewerDeciding(SMALL_TIPPER_TRACK).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 5. Dispatched without error, and the queued referendum started deciding
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  const startedRecords = await referendumEvents(client, index, 'DecisionStarted')
  expect(startedRecords).toHaveLength(1)
  await check([...dispatched, ...startedRecords])
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('one fewer deciding: Dispatched and DecisionStarted events')

  const started = startedRecords[0].event
  assert(client.api.events.referenda.DecisionStarted.is(started))
  expect(started.data.track.toNumber()).toBe(SMALL_TIPPER_TRACK)

  const deciding = await ongoingStatus(client, index)
  expect(deciding.inQueue.isFalse).toBe(true)
  assert(deciding.deciding.isSome)
  expect(deciding.deciding.unwrap().since.toNumber(), 'deciding from the relay number the scheduler saw').toBe(
    agendaBlock,
  )

  // 6. Queue empty, deciding count unchanged
  expect(await client.api.query.referenda.trackQueue(SMALL_TIPPER_TRACK)).toHaveLength(0)
  expect((await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()).toBe(maxDeciding)
}

/**
 * `one_fewer_deciding` for a track the runtime does not define fails with `BadTrack`.
 *
 * 1. Pick a track id that is not in the runtime's `tracks` constant
 * 2. Dispatch `one_fewer_deciding` for it as Root
 * 3. Verify the dispatch failed with `BadTrack`
 */
async function oneFewerDecidingUnknownTrackFails(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties

  // 1. An undefined track id
  const unknownTrack = 999
  const trackIds = client.api.consts.referenda.tracks.map(([id]) => id.toNumber())
  expect(trackIds).not.toContain(unknownTrack)

  // 2. `one_fewer_deciding` as Root
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.oneFewerDeciding(unknownTrack).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadTrack`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('unknown track: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'BadTrack')
}

/// -------
/// Tests: time-driven transitions
/// -------

/**
 * A referendum without a decision deposit times out `UndecidingTimeout` relay blocks after
 * submission.
 *
 * The test moves `submitted` back so that the timeout falls one relay block after the scheduler's
 * clock in the next block, then nudges the referendum as Root in that block. The nudge finds it one
 * relay block short of the timeout, so it stays ongoing and the pallet re-arms its alarm at the
 * timeout block. The scheduler dispatches that alarm once its clock reaches the timeout, and the
 * referendum times out. Its submission deposit stays reserved, since a timed-out referendum's
 * submission deposit cannot be refunded.
 *
 * 1. Fund the submitter and submit a referendum, with no decision deposit
 * 2. Move `submitted` back so the timeout falls one relay block after the next block's scheduler clock
 * 3. Nudge the referendum as Root, and verify it is still ongoing with its alarm at the timeout
 * 4. Build blocks until the alarm fires, and verify it dispatched and emitted `TimedOut`
 * 5. Verify the stored `TimedOut` record and that the submission deposit stays reserved
 */
async function nudgeThenAlarmTimesOutReferendum(client: Client<any, any>) {
  const { alice } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const undecidingTimeout = client.api.consts.referenda.undecidingTimeout.toNumber()
  const alarmInterval = client.api.consts.referenda.alarmInterval.toNumber()
  const { schedulerBlockProvider } = client.config.properties

  // 1. Submit without a decision deposit
  await fundAccounts(client, alice)
  const index = await submitReferendum(client, alice)

  // 2. Move `submitted` back
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  const timeoutBlock = agendaBlock + 1
  await rewriteOngoing(client, index, { submitted: timeoutBlock - undecidingTimeout })
  expect((await ongoingStatus(client, index)).submitted.toNumber()).toBe(timeoutBlock - undecidingTimeout)

  // 3. A Root nudge one relay block before the timeout leaves it ongoing and re-arms the alarm
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.nudgeReferendum(index).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const nudged = await dispatchedFromAgenda(client, agendaBlock)
  expect(nudged).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(nudged[0].event))
  expect(nudged[0].event.data.result.isOk).toBe(true)
  expect(await referendumEvents(client, index, 'TimedOut')).toHaveLength(0)

  const waiting = await ongoingStatus(client, index)
  expect(waiting.decisionDeposit.isNone).toBe(true)
  assert(waiting.alarm.isSome)
  const [alarmBlock, [, alarmAgendaIndex]] = waiting.alarm.unwrap()
  expect(alarmBlock.toNumber(), 'the alarm is re-armed at the timeout').toBe(
    Math.ceil(timeoutBlock / alarmInterval) * alarmInterval,
  )

  // 4. The alarm fires and times the referendum out
  const relaySeen = await buildBlocksUntilScheduled(client, alarmBlock.toNumber())

  const alarmDispatched = (await dispatchedFromAgenda(client, alarmBlock.toNumber())).filter(
    ({ event }) => (event.data as any).task[1].toNumber() === alarmAgendaIndex.toNumber(),
  )
  expect(alarmDispatched).toHaveLength(1)
  const timedOutRecords = await referendumEvents(client, index, 'TimedOut')
  expect(timedOutRecords).toHaveLength(1)
  await check([...alarmDispatched, ...timedOutRecords])
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('undeciding timeout: alarm Dispatched and TimedOut events')

  assert(client.api.events.scheduler.Dispatched.is(alarmDispatched[0].event))
  expect(alarmDispatched[0].event.data.result.isOk).toBe(true)
  const timedOut = timedOutRecords[0].event
  assert(client.api.events.referenda.TimedOut.is(timedOut))
  expect(timedOut.data.tally.ayes.toBigInt()).toBe(0n)
  expect(timedOut.data.tally.nays.toBigInt()).toBe(0n)
  expect(timedOut.data.tally.support.toBigInt()).toBe(0n)

  // 5. `TimedOut(end, submission deposit, no decision deposit)`, deposit still reserved
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  assert(info.unwrap().isTimedOut)
  const [end, submission, decision] = info.unwrap().asTimedOut
  expect(end.toNumber(), 'the end is the relay number the scheduler saw').toBe(relaySeen)
  assert(submission.isSome)
  expect(submission.unwrap().who.toString()).toBe(addressOf(client, alice))
  expect(submission.unwrap().amount.toBigInt()).toBe(submissionDeposit)
  expect(decision.isNone).toBe(true)
  expect(await getReservedFunds(client, alice.address)).toBe(submissionDeposit)
}

/**
 * A deciding referendum starts confirming while it passes, and stops confirming when it no longer
 * does.
 *
 * Passing means meeting the track's approval and support curves, which fall over the decision
 * period. The test moves `deciding.since` back until only `DECISION_PERIOD_LEFT` relay blocks of
 * `small_tipper`'s decision period remain, where the support needed is a tiny fraction of
 * issuance. One aye vote of 1% of total issuance then passes, and removing it makes the referendum
 * fail again before the decision period ends. Each vote change re-arms the referendum's alarm for
 * the next relay block, and the nudge it dispatches emits `ConfirmStarted`, then `ConfirmAborted`.
 * Voting is only the means here; conviction voting has its own suite.
 *
 * 1. Fund the accounts, submit a referendum, place its decision deposit, and let it start deciding
 * 2. Move `deciding.since` back so `DECISION_PERIOD_LEFT` relay blocks of the decision period remain
 * 3. Vote aye with 1% of total issuance, and verify the vote re-armed the alarm
 * 4. Build blocks until the alarm fires, and verify `ConfirmStarted` and the confirmation deadline
 * 5. Remove the vote, and verify the alarm was re-armed
 * 6. Build blocks until the alarm fires, and verify `ConfirmAborted`
 * 7. Verify the referendum is still deciding and no longer confirming
 */
async function confirmationStartsThenAborts(client: Client<any, any>) {
  const { alice, bob, charlie } = testAccounts
  const track = trackInfo(client, SMALL_TIPPER_TRACK)
  const { schedulerBlockProvider } = client.config.properties
  const voteBalance = (await client.api.query.balances.totalIssuance()).toBigInt() / 100n

  // 1. Submit, place the deposit, and wait for deciding to start
  await fundAccounts(client, alice, bob)
  await setupBalances(client, [{ address: charlie.address, amount: 2n * voteBalance }])
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)
  const preparing = await ongoingStatus(client, index)
  assert(preparing.alarm.isSome)
  await buildBlocksUntilScheduled(client, preparing.alarm.unwrap()[0].toNumber())
  expect(await referendumEvents(client, index, 'DecisionStarted'), 'setup: deciding did not start').toHaveLength(1)

  // 2. Move `deciding.since` back, and `submitted` with it so the prepare period still precedes it
  const relayNow = await getBlockNumber(client.api, schedulerBlockProvider)
  const decidingSince = relayNow - track.decisionPeriod.toNumber() + DECISION_PERIOD_LEFT
  await rewriteOngoing(client, index, {
    submitted: decidingSince - track.preparePeriod.toNumber(),
    deciding: { since: decidingSince, confirming: null },
  })
  const backdated = await ongoingStatus(client, index)
  assert(backdated.deciding.isSome)
  expect(backdated.deciding.unwrap().since.toNumber()).toBe(decidingSince)
  expect(backdated.deciding.unwrap().confirming.isNone).toBe(true)

  // 3. Vote aye
  await sendTransaction(
    client.api.tx.convictionVoting
      .vote(index, { Standard: { vote: { aye: true, conviction: 'None' }, balance: voteBalance } })
      .signAsync(charlie),
  )
  await client.dev.newBlock()

  const relayAtVote = await getBlockNumber(client.api, schedulerBlockProvider)
  const voted = await ongoingStatus(client, index)
  expect(voted.tally.support.toBigInt(), 'setup: the vote was not counted').toBe(voteBalance)
  assert(voted.alarm.isSome)
  const confirmAlarm = voted.alarm.unwrap()[0].toNumber()
  expect(confirmAlarm, 'a vote re-arms the alarm for the next relay block').toBe(relayAtVote + 1)

  // 4. The alarm's nudge starts confirmation
  const relayAtConfirm = await buildBlocksUntilScheduled(client, confirmAlarm)

  const startedRecords = await referendumEvents(client, index, 'ConfirmStarted')
  expect(startedRecords).toHaveLength(1)
  await check(startedRecords)
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('passing: ConfirmStarted event')
  assert(client.api.events.referenda.ConfirmStarted.is(startedRecords[0].event))

  const confirming = await ongoingStatus(client, index)
  assert(confirming.deciding.isSome)
  const confirmUntil = confirming.deciding.unwrap().confirming
  assert(confirmUntil.isSome)
  expect(confirmUntil.unwrap().toNumber(), 'confirmation lasts the confirm period').toBe(
    relayAtConfirm + track.confirmPeriod.toNumber(),
  )

  // 5. Remove the vote
  await sendTransaction(client.api.tx.convictionVoting.removeVote(SMALL_TIPPER_TRACK, index).signAsync(charlie))
  await client.dev.newBlock()

  const unvoted = await ongoingStatus(client, index)
  expect(unvoted.tally.support.toBigInt(), 'setup: the vote was not removed').toBe(0n)
  assert(unvoted.alarm.isSome)
  const abortAlarm = unvoted.alarm.unwrap()[0].toNumber()

  // 6. The alarm's nudge aborts confirmation
  await buildBlocksUntilScheduled(client, abortAlarm)

  const abortedRecords = await referendumEvents(client, index, 'ConfirmAborted')
  expect(abortedRecords).toHaveLength(1)
  await check(abortedRecords)
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('no longer passing: ConfirmAborted event')
  assert(client.api.events.referenda.ConfirmAborted.is(abortedRecords[0].event))
  expect(await referendumEvents(client, index, 'Rejected'), 'the decision period has not ended').toHaveLength(0)

  // 7. Still deciding, no longer confirming
  const aborted = await ongoingStatus(client, index)
  assert(aborted.deciding.isSome)
  expect(aborted.deciding.unwrap().since.toNumber()).toBe(decidingSince)
  expect(aborted.deciding.unwrap().confirming.isNone).toBe(true)
}

/// -------
/// Tests: cancel and kill
/// -------

/**
 * `ReferendumCanceller` cancels a deciding referendum, and its deciding slot is released one
 * block later.
 *
 * The runtime's `CancelOrigin` admits Root and the `ReferendumCanceller` origin. Cancelling keeps
 * both deposits on the referendum for later refunds. Because the referendum held a deciding slot,
 * the pallet schedules `one_fewer_deciding` for the next relay block instead of freeing the slot at
 * once, so the track's deciding count drops a block later.
 *
 * 1. Fund the accounts, submit a referendum, place its decision deposit, and let it start deciding
 * 2. Cancel it with the `ReferendumCanceller` origin
 * 3. Verify the dispatch succeeded and `Cancelled` was emitted
 * 4. Verify the stored `Cancelled` record keeps both deposits, which stay reserved
 * 5. Verify the deciding count has not changed yet, and `one_fewer_deciding` is scheduled
 * 6. Build blocks until it is dispatched, and verify it released the slot
 */
async function cancellerCancelsDecidingReferendum(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const decisionDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()
  const alarmInterval = client.api.consts.referenda.alarmInterval.toNumber()
  const { schedulerBlockProvider } = client.config.properties

  // 1. A deciding referendum
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)
  const preparing = await ongoingStatus(client, index)
  assert(preparing.alarm.isSome)
  await buildBlocksUntilScheduled(client, preparing.alarm.unwrap()[0].toNumber())
  expect(await referendumEvents(client, index, 'DecisionStarted'), 'setup: deciding did not start').toHaveLength(1)
  const decidingCount = (await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()

  // 2. Cancel with `ReferendumCanceller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.cancel(index).method.toHex(),
    { Origins: 'ReferendumCanceller' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched without error, `Cancelled` emitted
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  const cancelledRecords = await referendumEvents(client, index, 'Cancelled')
  expect(cancelledRecords).toHaveLength(1)
  await check([...dispatched, ...cancelledRecords])
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('canceller cancels: Dispatched and Cancelled events')
  const cancelled = cancelledRecords[0].event
  assert(client.api.events.referenda.Cancelled.is(cancelled))
  expect(cancelled.data.tally.ayes.toBigInt()).toBe(0n)
  expect(cancelled.data.tally.support.toBigInt()).toBe(0n)

  // 4. `Cancelled(end, submission deposit, decision deposit)`, both still reserved
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  assert(info.unwrap().isCancelled)
  const [end, submission, decision] = info.unwrap().asCancelled
  expect(end.toNumber(), 'the end is the relay number the scheduler saw').toBe(agendaBlock)
  assert(submission.isSome)
  expect(submission.unwrap().who.toString()).toBe(addressOf(client, alice))
  expect(submission.unwrap().amount.toBigInt()).toBe(submissionDeposit)
  assert(decision.isSome)
  expect(decision.unwrap().who.toString()).toBe(addressOf(client, bob))
  expect(decision.unwrap().amount.toBigInt()).toBe(decisionDeposit)
  expect(await getReservedFunds(client, alice.address)).toBe(submissionDeposit)
  expect(await getReservedFunds(client, bob.address)).toBe(decisionDeposit)

  // 5. The slot is still taken, and `one_fewer_deciding` waits in the next relay block's agenda
  expect((await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()).toBe(decidingCount)
  const releaseBlock = Math.ceil((agendaBlock + 1) / alarmInterval) * alarmInterval
  const oneFewerDecidingCall = client.api.tx.referenda.oneFewerDeciding(SMALL_TIPPER_TRACK).method.toHex()
  const releaseAgenda = await client.api.query.scheduler.agenda(releaseBlock)
  const releaseTaskIndex = releaseAgenda.findIndex(
    (task) =>
      task.isSome && task.unwrap().call.isInline && task.unwrap().call.asInline.toHex() === oneFewerDecidingCall,
  )
  expect(releaseTaskIndex, '`one_fewer_deciding` is scheduled for the next relay block').toBeGreaterThanOrEqual(0)

  // 6. Once dispatched, it releases the slot
  await buildBlocksUntilScheduled(client, releaseBlock)
  const released = (await dispatchedFromAgenda(client, releaseBlock)).filter(
    ({ event }) => (event.data as any).task[1].toNumber() === releaseTaskIndex,
  )
  expect(released).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(released[0].event))
  expect(released[0].event.data.result.isOk).toBe(true)
  expect((await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()).toBe(decidingCount - 1)
}

/**
 * `ReferendumKiller` kills a referendum: both deposits are slashed to the chain's slash
 * destination, and its metadata is cleared.
 *
 * The runtime's `KillOrigin` admits Root and the `ReferendumKiller` origin. Killing slashes the
 * submission and decision deposits through the runtime's `Slash` handler, whose destination
 * differs by chain (`ReferendaTestConfig.slashDestination`), and clears the referendum's metadata.
 *
 * 1. Fund the accounts, submit a referendum, place its decision deposit, and set its metadata
 * 2. Kill it with the `ReferendumKiller` origin
 * 3. Verify the dispatch succeeded, and the `Killed`, `DepositSlashed` and `MetadataCleared` events
 * 4. Verify both deposits were slashed from the depositors and credited to the slash destination
 * 5. Verify the depositors' reserved balances lost the deposits and their free balances did not change
 * 6. Verify the stored `Killed` record and that the metadata is gone
 */
async function killerKillsReferendum(client: Client<any, any>, testConfig: ReferendaTestConfig) {
  const { alice, bob } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const decisionDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()
  const { schedulerBlockProvider } = client.config.properties
  const depositors = [addressOf(client, alice), addressOf(client, bob)]
  const destination = slashDestinationAddress(client, testConfig.slashDestination)

  // 1. A referendum with both deposits and metadata
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)
  const metadataHash = await notePreimage(client, alice, 'referenda e2e metadata')
  await setMetadata(client, alice, index, metadataHash)

  const aliceFree = await getFreeFunds(client, alice.address)
  const aliceReserved = await getReservedFunds(client, alice.address)
  const bobFree = await getFreeFunds(client, bob.address)
  const bobReserved = await getReservedFunds(client, bob.address)

  // 2. Kill with `ReferendumKiller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.kill(index).method.toHex(),
    { Origins: 'ReferendumKiller' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched without error; `Killed`, both `DepositSlashed` and `MetadataCleared`, in that order
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  const events = await client.api.query.system.events()
  const killRecords = events.filter(
    ({ event }) =>
      event.section === 'referenda' &&
      ((event.data as any).index?.toNumber() === index ||
        (client.api.events.referenda.DepositSlashed.is(event) && depositors.includes(event.data.who.toString()))),
  )
  expect(killRecords.map(({ event }) => event.method)).toEqual([
    'Killed',
    'DepositSlashed',
    'DepositSlashed',
    'MetadataCleared',
  ])
  await check(killRecords)
    .filterEvents()
    .redact()
    // The metadata hash is the value under test, and fixed by the test, so it is not redacted.
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('killer kills: Killed, DepositSlashed and MetadataCleared events')

  const [killed, submissionSlash, decisionSlash, metadataCleared] = killRecords.map(({ event }) => event)
  assert(client.api.events.referenda.Killed.is(killed))
  expect(killed.data.tally.ayes.toBigInt()).toBe(0n)
  expect(killed.data.tally.support.toBigInt()).toBe(0n)
  assert(client.api.events.referenda.DepositSlashed.is(submissionSlash))
  expect(submissionSlash.data.who.toString()).toBe(addressOf(client, alice))
  expect(submissionSlash.data.amount.toBigInt()).toBe(submissionDeposit)
  assert(client.api.events.referenda.DepositSlashed.is(decisionSlash))
  expect(decisionSlash.data.who.toString()).toBe(addressOf(client, bob))
  expect(decisionSlash.data.amount.toBigInt()).toBe(decisionDeposit)
  assert(client.api.events.referenda.MetadataCleared.is(metadataCleared))
  // The field is read by position: `data.hash` is the codec's own hash of the event data.
  expect(metadataCleared.data[1].toHex()).toBe(metadataHash)

  // 4. Slashed from the depositors, credited to the slash destination
  const transferRecords = events.filter(
    ({ event }) =>
      (client.api.events.balances.Slashed.is(event) && depositors.includes(event.data.who.toString())) ||
      (client.api.events.balances.Deposit.is(event) && event.data.who.toString() === destination) ||
      client.api.events.treasury.Deposit.is(event),
  )
  await check(transferRecords)
    .filterEvents()
    .redact()
    .toMatchSnapshot('killer kills: deposits slashed and credited to the slash destination')

  const credited = transferRecords
    .map(({ event }) => event)
    .filter((event) => client.api.events.balances.Deposit.is(event))
    .map((event) => (event.data as any).amount.toBigInt())
  expect(credited, 'each deposit is credited to the slash destination').toEqual([submissionDeposit, decisionDeposit])
  if (testConfig.slashDestination === 'treasury') {
    const treasuryDeposits = transferRecords
      .map(({ event }) => event)
      .filter((event) => client.api.events.treasury.Deposit.is(event))
      .map((event) => (event.data as any).value.toBigInt())
    expect(treasuryDeposits, 'the treasury records each deposit').toEqual([submissionDeposit, decisionDeposit])
  }

  // 5. Deposits gone from reserved balances, free balances untouched
  expect(await getReservedFunds(client, alice.address)).toBe(aliceReserved - submissionDeposit)
  expect(await getFreeFunds(client, alice.address)).toBe(aliceFree)
  expect(await getReservedFunds(client, bob.address)).toBe(bobReserved - decisionDeposit)
  expect(await getFreeFunds(client, bob.address)).toBe(bobFree)

  // 6. `Killed(end)`, metadata gone
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  assert(info.unwrap().isKilled)
  expect(info.unwrap().asKilled.toNumber(), 'the end is the relay number the scheduler saw').toBe(agendaBlock)
  expect((await client.api.query.referenda.metadataOf(index)).isNone).toBe(true)
}

/**
 * Calls that need an ongoing referendum fail with `NotOngoing` once it is cancelled.
 *
 * Root dispatches four calls in one block: a `cancel` that succeeds, then `kill`,
 * `nudge_referendum` and a second `cancel`, which all find the referendum already cancelled.
 *
 * 1. Fund the submitter and submit a referendum
 * 2. Dispatch `cancel`, `kill`, `nudge_referendum` and `cancel` for it as Root, in that order
 * 3. Verify the first dispatch succeeded and the other three failed with `NotOngoing`
 * 4. Verify one `Cancelled` event, no `Killed` event, and that the referendum is stored as cancelled
 */
async function callsOnCancelledReferendumFail(client: Client<any, any>) {
  const { alice } = testAccounts
  const { schedulerBlockProvider } = client.config.properties

  // 1. Submit
  await fundAccounts(client, alice)
  const index = await submitReferendum(client, alice)

  // 2. Four Root calls in one block
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.referenda.cancel(index).method.toHex(),
      client.api.tx.referenda.kill(index).method.toHex(),
      client.api.tx.referenda.nudgeReferendum(index).method.toHex(),
      client.api.tx.referenda.cancel(index).method.toHex(),
    ],
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. The first succeeds; the rest find the referendum cancelled
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(4)
  await check(dispatched)
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('calls on a cancelled referendum: Dispatched events')
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)
  for (const record of dispatched.slice(1)) {
    expectDispatchedError(client, record, 'NotOngoing')
  }

  // 4. Cancelled once, never killed
  expect(await referendumEvents(client, index, 'Cancelled')).toHaveLength(1)
  expect(await referendumEvents(client, index, 'Killed')).toHaveLength(0)
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  expect(info.unwrap().isCancelled).toBe(true)
}

/// -------
/// Tests: refunds
/// -------

/**
 * Any signed account can refund a cancelled referendum's deposits. Each goes back to the account
 * that placed it, and only once.
 *
 * A cancelled referendum keeps both deposits. `refund_decision_deposit` and
 * `refund_submission_deposit` admit any signed caller and unreserve each deposit for its
 * depositor; the caller gains nothing. A second refund of either deposit fails with `NoDeposit`.
 *
 * 1. Fund the accounts, submit a referendum, place its decision deposit, and cancel it as Root
 * 2. Refund the decision deposit from a third account
 * 3. Verify `DecisionDepositRefunded` and that the depositor got the deposit back
 * 4. Refund the submission deposit from the third account
 * 5. Verify `SubmissionDepositRefunded` and that the submitter got the deposit back
 * 6. Verify the stored `Cancelled` record no longer holds either deposit
 * 7. Refund each deposit again, and verify both attempts fail with `NoDeposit`
 */
async function thirdPartyRefundsCancelledDeposits(client: Client<any, any>) {
  const { alice, bob, charlie } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const decisionDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()

  // 1. A cancelled referendum holding both deposits
  await fundAccounts(client, alice, bob, charlie)
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)
  await dispatchAsRoot(client, client.api.tx.referenda.cancel(index))
  const aliceFree = await getFreeFunds(client, alice.address)
  const bobFree = await getFreeFunds(client, bob.address)

  // 2. Refund the decision deposit from a third account
  await sendTransaction(client.api.tx.referenda.refundDecisionDeposit(index).signAsync(charlie))
  await client.dev.newBlock()

  // 3. `DecisionDepositRefunded`, back with the depositor
  await checkSystemEvents(
    client,
    { section: 'referenda', method: 'DecisionDepositRefunded' },
    { section: 'balances', method: 'Unreserved' },
  )
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('third party refund: DecisionDepositRefunded and Unreserved events')
  const decisionRefunds = await referendumEvents(client, index, 'DecisionDepositRefunded')
  expect(decisionRefunds).toHaveLength(1)
  const decisionRefund = decisionRefunds[0].event
  assert(client.api.events.referenda.DecisionDepositRefunded.is(decisionRefund))
  expect(decisionRefund.data.who.toString(), 'the refund goes to the depositor').toBe(addressOf(client, bob))
  expect(decisionRefund.data.amount.toBigInt()).toBe(decisionDeposit)
  expect(await getReservedFunds(client, bob.address)).toBe(0n)
  expect(await getFreeFunds(client, bob.address)).toBe(bobFree + decisionDeposit)

  // 4. Refund the submission deposit from the third account
  await sendTransaction(client.api.tx.referenda.refundSubmissionDeposit(index).signAsync(charlie))
  await client.dev.newBlock()

  // 5. `SubmissionDepositRefunded`, back with the submitter
  await checkSystemEvents(
    client,
    { section: 'referenda', method: 'SubmissionDepositRefunded' },
    { section: 'balances', method: 'Unreserved' },
  )
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('third party refund: SubmissionDepositRefunded and Unreserved events')
  const submissionRefunds = await referendumEvents(client, index, 'SubmissionDepositRefunded')
  expect(submissionRefunds).toHaveLength(1)
  const submissionRefund = submissionRefunds[0].event
  assert(client.api.events.referenda.SubmissionDepositRefunded.is(submissionRefund))
  expect(submissionRefund.data.who.toString(), 'the refund goes to the submitter').toBe(addressOf(client, alice))
  expect(submissionRefund.data.amount.toBigInt()).toBe(submissionDeposit)
  expect(await getReservedFunds(client, alice.address)).toBe(0n)
  expect(await getFreeFunds(client, alice.address)).toBe(aliceFree + submissionDeposit)

  // 6. The record no longer holds either deposit, and the caller reserved nothing
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  assert(info.unwrap().isCancelled)
  const [, submission, decision] = info.unwrap().asCancelled
  expect(submission.isNone).toBe(true)
  expect(decision.isNone).toBe(true)
  expect(await getReservedFunds(client, charlie.address)).toBe(0n)

  // 7. A second refund of each deposit finds nothing
  await sendTransaction(client.api.tx.referenda.refundDecisionDeposit(index).signAsync(charlie))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'repeated refund: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'NoDeposit')

  await sendTransaction(client.api.tx.referenda.refundSubmissionDeposit(index).signAsync(charlie))
  await client.dev.newBlock()
  await expectExtrinsicError(client, 'referenda', 'NoDeposit')
}

/**
 * Root can refund a cancelled referendum's deposits, and they go back to the accounts that placed
 * them.
 *
 * Both refund calls admit Root as well as signed accounts. Root dispatches three calls in one
 * block: `cancel`, then both refunds.
 *
 * 1. Fund the accounts, submit a referendum, and place its decision deposit
 * 2. Dispatch `cancel`, `refund_decision_deposit` and `refund_submission_deposit` as Root
 * 3. Verify all three dispatches succeeded, with `Cancelled` and both refund events
 * 4. Verify each deposit is back with its depositor and the record holds neither
 */
async function rootRefundsCancelledDeposits(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const decisionDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()
  const { schedulerBlockProvider } = client.config.properties

  // 1. A referendum holding both deposits
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)
  const aliceFree = await getFreeFunds(client, alice.address)
  const bobFree = await getFreeFunds(client, bob.address)

  // 2. Cancel and refund, as Root
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.referenda.cancel(index).method.toHex(),
      client.api.tx.referenda.refundDecisionDeposit(index).method.toHex(),
      client.api.tx.referenda.refundSubmissionDeposit(index).method.toHex(),
    ],
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. All three dispatched without error
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(3)
  for (const { event } of dispatched) {
    assert(client.api.events.scheduler.Dispatched.is(event))
    expect(event.data.result.isOk).toBe(true)
  }
  const referendaRecords = await referendumEvents(
    client,
    index,
    'Cancelled',
    'DecisionDepositRefunded',
    'SubmissionDepositRefunded',
  )
  expect(referendaRecords.map(({ event }) => event.method)).toEqual([
    'Cancelled',
    'DecisionDepositRefunded',
    'SubmissionDepositRefunded',
  ])
  await check([...dispatched, ...referendaRecords])
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('Root refunds: Dispatched, Cancelled and refund events')

  const [, decisionRefund, submissionRefund] = referendaRecords.map(({ event }) => event)
  assert(client.api.events.referenda.DecisionDepositRefunded.is(decisionRefund))
  expect(decisionRefund.data.who.toString()).toBe(addressOf(client, bob))
  expect(decisionRefund.data.amount.toBigInt()).toBe(decisionDeposit)
  assert(client.api.events.referenda.SubmissionDepositRefunded.is(submissionRefund))
  expect(submissionRefund.data.who.toString()).toBe(addressOf(client, alice))
  expect(submissionRefund.data.amount.toBigInt()).toBe(submissionDeposit)

  // 4. Deposits back with their depositors, none left on the record
  expect(await getFreeFunds(client, alice.address)).toBe(aliceFree + submissionDeposit)
  expect(await getReservedFunds(client, alice.address)).toBe(0n)
  expect(await getFreeFunds(client, bob.address)).toBe(bobFree + decisionDeposit)
  expect(await getReservedFunds(client, bob.address)).toBe(0n)
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  assert(info.unwrap().isCancelled)
  const [, submission, decision] = info.unwrap().asCancelled
  expect(submission.isNone).toBe(true)
  expect(decision.isNone).toBe(true)
}

/**
 * The decision deposit of an ongoing referendum cannot be refunded.
 *
 * Before any decision deposit is placed there is nothing to refund (`NoDeposit`); once one is
 * placed, it stays locked until the referendum is over (`Unfinished`).
 *
 * 1. Fund the accounts and submit a referendum
 * 2. Refund its decision deposit, and verify the call failed with `NoDeposit`
 * 3. Place the decision deposit
 * 4. Refund it, and verify the call failed with `Unfinished`
 * 5. Verify the deposit is still recorded and reserved
 */
async function refundOngoingDecisionDepositFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const decisionDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()

  // 1. Submit
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)

  // 2. Nothing to refund yet
  await sendTransaction(client.api.tx.referenda.refundDecisionDeposit(index).signAsync(bob))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund before a deposit: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'NoDeposit')

  // 3. Place the decision deposit
  await placeDecisionDeposit(client, bob, index)

  // 4. The deposit is locked while the referendum is ongoing
  await sendTransaction(client.api.tx.referenda.refundDecisionDeposit(index).signAsync(bob))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund while ongoing: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'Unfinished')

  // 5. Still recorded and reserved
  const status = await ongoingStatus(client, index)
  assert(status.decisionDeposit.isSome)
  expect(status.decisionDeposit.unwrap().amount.toBigInt()).toBe(decisionDeposit)
  expect(await getReservedFunds(client, bob.address)).toBe(decisionDeposit)
}

/**
 * Nothing can be refunded from a killed referendum.
 *
 * Killing slashes both deposits, so the decision deposit refund finds none (`NoDeposit`), and a
 * killed referendum is not a state that allows a submission deposit refund (`BadStatus`).
 *
 * 1. Fund the accounts, submit a referendum, place its decision deposit, and kill it as Root
 * 2. Refund the decision deposit, and verify the call failed with `NoDeposit`
 * 3. Refund the submission deposit, and verify the call failed with `BadStatus`
 * 4. Verify neither depositor got anything back
 */
async function refundKilledDepositsFails(client: Client<any, any>) {
  const { alice, bob, charlie } = testAccounts

  // 1. A killed referendum
  await fundAccounts(client, alice, bob, charlie)
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)
  await dispatchAsRoot(client, client.api.tx.referenda.kill(index))
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  expect(info.unwrap().isKilled, 'setup: the referendum was not killed').toBe(true)
  const aliceFree = await getFreeFunds(client, alice.address)
  const bobFree = await getFreeFunds(client, bob.address)

  // 2. No decision deposit left
  await sendTransaction(client.api.tx.referenda.refundDecisionDeposit(index).signAsync(charlie))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'decision refund after kill: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'NoDeposit')

  // 3. A killed referendum allows no submission deposit refund
  await sendTransaction(client.api.tx.referenda.refundSubmissionDeposit(index).signAsync(charlie))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'submission refund after kill: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'BadStatus')

  // 4. Nothing came back
  expect(await getFreeFunds(client, alice.address)).toBe(aliceFree)
  expect(await getReservedFunds(client, alice.address)).toBe(0n)
  expect(await getFreeFunds(client, bob.address)).toBe(bobFree)
  expect(await getReservedFunds(client, bob.address)).toBe(0n)
}

/// -------
/// Tests: metadata
/// -------

/**
 * The submitter sets a referendum's metadata to a noted preimage, then clears it.
 *
 * Metadata is the hash of a preimage holding off-chain information about the referendum.
 * Clearing it emits `MetadataCleared` only when there was metadata to clear, so a second clear
 * succeeds without an event.
 *
 * 1. Fund the submitter, submit a referendum, and note a preimage
 * 2. Set the preimage's hash as the referendum's metadata
 * 3. Verify `MetadataSet` and the stored hash
 * 4. Clear the metadata
 * 5. Verify `MetadataCleared` and that nothing is stored
 * 6. Clear it again, and verify the call succeeds without a `referenda` event
 */
async function submitterSetsAndClearsMetadata(client: Client<any, any>) {
  const { alice } = testAccounts

  // 1. Submit and note a preimage
  await fundAccounts(client, alice)
  const index = await submitReferendum(client, alice)
  const hash = await notePreimage(client, alice, 'referenda e2e metadata')

  // 2. Set the metadata
  await sendTransaction(client.api.tx.referenda.setMetadata(index, hash).signAsync(alice))
  await client.dev.newBlock()

  // 3. `MetadataSet`, hash stored
  const setRecords = await referendumEvents(client, index, 'MetadataSet')
  expect(setRecords).toHaveLength(1)
  await check(setRecords)
    .filterEvents()
    .redact()
    // The metadata hash is the value under test, and fixed by the test, so it is not redacted.
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('set metadata: MetadataSet event')
  assert(client.api.events.referenda.MetadataSet.is(setRecords[0].event))
  // The field is read by position: `data.hash` is the codec's own hash of the event data.
  expect(setRecords[0].event.data[1].toHex()).toBe(hash)
  const stored = await client.api.query.referenda.metadataOf(index)
  assert(stored.isSome)
  expect(stored.unwrap().toHex()).toBe(hash)

  // 4. Clear the metadata
  await sendTransaction(client.api.tx.referenda.setMetadata(index, null).signAsync(alice))
  await client.dev.newBlock()

  // 5. `MetadataCleared`, nothing stored
  const clearedRecords = await referendumEvents(client, index, 'MetadataCleared')
  expect(clearedRecords).toHaveLength(1)
  await check(clearedRecords)
    .filterEvents()
    .redact()
    // The metadata hash is the value under test, and fixed by the test, so it is not redacted.
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('clear metadata: MetadataCleared event')
  assert(client.api.events.referenda.MetadataCleared.is(clearedRecords[0].event))
  expect(clearedRecords[0].event.data[1].toHex()).toBe(hash)
  expect((await client.api.query.referenda.metadataOf(index)).isNone).toBe(true)

  // 6. A second clear succeeds with nothing to report
  await sendTransaction(client.api.tx.referenda.setMetadata(index, null).signAsync(alice))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  expect(events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))).toHaveLength(0)
  // The block's inherents succeed with class `Mandatory`, so the one `Normal` success is the clear.
  const normalSuccesses = events.filter(
    ({ event }) => client.api.events.system.ExtrinsicSuccess.is(event) && event.data.dispatchInfo.class.isNormal,
  )
  expect(normalSuccesses).toHaveLength(1)
  // Live referenda may emit events in this block, so only this referendum's events are counted.
  const ownEvents = events.filter(
    ({ event }) => event.section === 'referenda' && (event.data as any).index?.toNumber() === index,
  )
  expect(ownEvents).toHaveLength(0)
}

/**
 * Only the submitter can set or clear an ongoing referendum's metadata.
 *
 * Another account's attempt fails with `NoPermission`, for setting a hash and for clearing alike,
 * and the submitter's metadata stays.
 *
 * 1. Fund the accounts, submit a referendum, and set its metadata as the submitter
 * 2. Set metadata from another account, and verify the call failed with `NoPermission`
 * 3. Clear the metadata from that account, and verify the call failed with `NoPermission`
 * 4. Verify the submitter's metadata is still stored
 */
async function nonSubmitterMetadataFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts

  // 1. Metadata set by the submitter
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  const hash = await notePreimage(client, alice, 'referenda e2e metadata')
  await setMetadata(client, alice, index, hash)

  // 2. Another account sets metadata
  await sendTransaction(client.api.tx.referenda.setMetadata(index, hash).signAsync(bob))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'set metadata by another account: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'NoPermission')

  // 3. Another account clears metadata
  await sendTransaction(client.api.tx.referenda.setMetadata(index, null).signAsync(bob))
  await client.dev.newBlock()
  await expectExtrinsicError(client, 'referenda', 'NoPermission')

  // 4. The submitter's metadata stays
  const stored = await client.api.query.referenda.metadataOf(index)
  assert(stored.isSome)
  expect(stored.unwrap().toHex()).toBe(hash)
}

/**
 * Metadata must point at a noted preimage.
 *
 * Setting a hash that has no preimage on chain fails with `PreimageNotExist`.
 *
 * 1. Fund the submitter and submit a referendum
 * 2. Verify no preimage exists for the chosen hash
 * 3. Set that hash as metadata
 * 4. Verify the call failed with `PreimageNotExist` and no metadata is stored
 */
async function metadataWithoutPreimageFails(client: Client<any, any>) {
  const { alice } = testAccounts

  // 1. Submit
  await fundAccounts(client, alice)
  const index = await submitReferendum(client, alice)

  // 2. A hash with no preimage
  const hash = blake2AsHex(stringToHex('referenda e2e metadata that was never noted'), 256)
  expect((await client.api.query.preimage.requestStatusFor(hash)).isNone).toBe(true)

  // 3. Set it as metadata
  await sendTransaction(client.api.tx.referenda.setMetadata(index, hash).signAsync(alice))
  await client.dev.newBlock()

  // 4. `PreimageNotExist`, nothing stored
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'metadata without preimage: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'PreimageNotExist')
  expect((await client.api.query.referenda.metadataOf(index)).isNone).toBe(true)
}

/**
 * Once a referendum is over, anyone can clear its metadata, and nobody can set it.
 *
 * Cancelling keeps the metadata, so the preimage it points at stays findable. After that,
 * clearing it is open to any signed account, while setting it fails with `NotOngoing`, even for
 * the submitter.
 *
 * 1. Fund the accounts, submit a referendum, set its metadata, and cancel it as Root
 * 2. Verify the metadata survived the cancellation
 * 3. Clear the metadata from an account that is not the submitter
 * 4. Verify `MetadataCleared` and that nothing is stored
 * 5. Set metadata as the submitter, and verify the call failed with `NotOngoing`
 */
async function finishedReferendumMetadata(client: Client<any, any>) {
  const { alice, bob } = testAccounts

  // 1. A cancelled referendum with metadata
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  const hash = await notePreimage(client, alice, 'referenda e2e metadata')
  await setMetadata(client, alice, index, hash)
  await dispatchAsRoot(client, client.api.tx.referenda.cancel(index))

  // 2. Cancelling keeps the metadata
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  expect(info.unwrap().isCancelled, 'setup: the referendum was not cancelled').toBe(true)
  const kept = await client.api.query.referenda.metadataOf(index)
  assert(kept.isSome, 'cancelling keeps the metadata')
  expect(kept.unwrap().toHex()).toBe(hash)

  // 3. Another account clears it
  await sendTransaction(client.api.tx.referenda.setMetadata(index, null).signAsync(bob))
  await client.dev.newBlock()

  // 4. `MetadataCleared`, nothing stored
  const clearedRecords = await referendumEvents(client, index, 'MetadataCleared')
  expect(clearedRecords).toHaveLength(1)
  await check(clearedRecords)
    .filterEvents()
    .redact()
    // The metadata hash is the value under test, and fixed by the test, so it is not redacted.
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('clear metadata after cancel: MetadataCleared event')
  assert(client.api.events.referenda.MetadataCleared.is(clearedRecords[0].event))
  expect(clearedRecords[0].event.data[1].toHex()).toBe(hash)
  expect((await client.api.query.referenda.metadataOf(index)).isNone).toBe(true)

  // 5. Nobody can set it
  await sendTransaction(client.api.tx.referenda.setMetadata(index, hash).signAsync(alice))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'set metadata after cancel: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, 'referenda', 'NotOngoing')
  expect((await client.api.query.referenda.metadataOf(index)).isNone).toBe(true)
}

/// -------
/// Tests: origins and indices
/// -------

/**
 * Calls gated to Root or to admin origins reject a signed origin with `BadOrigin`.
 *
 * `cancel` admits Root and `ReferendumCanceller`, `kill` admits Root and `ReferendumKiller`, and
 * `nudge_referendum` and `one_fewer_deciding` admit Root only. A signed account sends all four in
 * one `utility.force_batch`, which runs every call and reports each failure.
 *
 * 1. Fund the accounts and submit a referendum
 * 2. Send `cancel`, `kill`, `nudge_referendum` and `one_fewer_deciding` in one `force_batch` from
 *    a signed account
 * 3. Verify every call failed with `BadOrigin` and the batch completed with errors
 * 4. Verify the referendum is still ongoing and the track's deciding count is unchanged
 */
async function signedOriginRejectedByGatedCalls(client: Client<any, any>) {
  const { alice, bob } = testAccounts

  // 1. Submit
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  const decidingCount = (await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()

  // 2. Four gated calls from a signed account
  await sendTransaction(
    client.api.tx.utility
      .forceBatch([
        client.api.tx.referenda.cancel(index),
        client.api.tx.referenda.kill(index),
        client.api.tx.referenda.nudgeReferendum(index),
        client.api.tx.referenda.oneFewerDeciding(SMALL_TIPPER_TRACK),
      ])
      .signAsync(bob),
  )
  await client.dev.newBlock()

  // 3. `BadOrigin` for each
  await checkSystemEvents(client, 'utility').toMatchSnapshot('signed origin: force_batch events')
  const events = await client.api.query.system.events()
  const itemsFailed = events.filter(({ event }) => client.api.events.utility.ItemFailed.is(event))
  expect(itemsFailed).toHaveLength(4)
  for (const { event } of itemsFailed) {
    assert(client.api.events.utility.ItemFailed.is(event))
    expect(event.data.error.isBadOrigin, `expected BadOrigin, got ${event.data.error.type}`).toBe(true)
  }
  expect(events.filter(({ event }) => client.api.events.utility.BatchCompletedWithErrors.is(event))).toHaveLength(1)

  // 4. Nothing changed
  expect((await ongoingStatus(client, index)).track.toNumber()).toBe(SMALL_TIPPER_TRACK)
  expect(await referendumEvents(client, index, 'Cancelled', 'Killed')).toHaveLength(0)
  expect((await client.api.query.referenda.decidingCount(SMALL_TIPPER_TRACK)).toNumber()).toBe(decidingCount)
}

/**
 * Calls that need a signed origin reject Root with `BadOrigin`.
 *
 * `submit` and `place_decision_deposit` take a deposit from the signer, and `set_metadata` checks
 * the signer against the submitter, so none of them admits Root. Root dispatches all three in one
 * block.
 *
 * 1. Fund the submitter and submit a referendum
 * 2. Dispatch `submit`, `place_decision_deposit` and `set_metadata` as Root
 * 3. Verify all three dispatches failed with `BadOrigin`
 * 4. Verify no referendum was added and the referendum has no decision deposit
 */
async function rootRejectedBySignedCalls(client: Client<any, any>) {
  const { alice } = testAccounts
  const { schedulerBlockProvider } = client.config.properties

  // 1. Submit
  await fundAccounts(client, alice)
  const index = await submitReferendum(client, alice)
  const countBefore = (await client.api.query.referenda.referendumCount()).toNumber()

  // 2. Three signed-only calls as Root
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.referenda.submit(SMALL_TIPPER_ORIGIN, remarkProposal(client), { After: 1 }).method.toHex(),
      client.api.tx.referenda.placeDecisionDeposit(index).method.toHex(),
      client.api.tx.referenda.setMetadata(index, null).method.toHex(),
    ],
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadOrigin` for each
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(3)
  await check(dispatched)
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('Root origin: Dispatched events')
  for (const { event } of dispatched) {
    assert(client.api.events.scheduler.Dispatched.is(event))
    assert(event.data.result.isErr, 'expected the dispatch to fail')
    expect(event.data.result.asErr.isBadOrigin, `expected BadOrigin, got ${event.data.result.asErr.type}`).toBe(true)
  }

  // 4. Nothing changed
  expect((await client.api.query.referenda.referendumCount()).toNumber()).toBe(countBefore)
  expect((await ongoingStatus(client, index)).decisionDeposit.isNone).toBe(true)
}

/**
 * Each admin origin passes only the gate it is configured for.
 *
 * `ReferendumCanceller` may cancel but not kill, and `ReferendumKiller` may kill but not cancel.
 * Neither is a signed account or Root, so neither may call the refund calls. All four calls are
 * dispatched in one block, each with an origin that must not pass it.
 *
 * 1. Fund the accounts, submit a referendum, and place its decision deposit
 * 2. Dispatch `cancel` as `ReferendumKiller`, `kill` as `ReferendumCanceller`,
 *    `refund_decision_deposit` as `ReferendumCanceller` and `refund_submission_deposit` as
 *    `ReferendumKiller`
 * 3. Verify all four dispatches failed with `BadOrigin`
 * 4. Verify the referendum is still ongoing and both deposits are still reserved
 */
async function adminOriginsOutsideTheirGateRejected(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const decisionDeposit = trackInfo(client, SMALL_TIPPER_TRACK).decisionDeposit.toBigInt()
  const { schedulerBlockProvider } = client.config.properties
  const canceller = { Origins: 'ReferendumCanceller' }
  const killer = { Origins: 'ReferendumKiller' }

  // 1. A referendum holding both deposits
  await fundAccounts(client, alice, bob)
  const index = await submitReferendum(client, alice)
  await placeDecisionDeposit(client, bob, index)

  // 2. Each call with an origin outside its gate
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleCallListWithOrigin(
    client,
    [
      { call: { Inline: client.api.tx.referenda.cancel(index).method.toHex() }, origin: killer },
      { call: { Inline: client.api.tx.referenda.kill(index).method.toHex() }, origin: canceller },
      { call: { Inline: client.api.tx.referenda.refundDecisionDeposit(index).method.toHex() }, origin: canceller },
      { call: { Inline: client.api.tx.referenda.refundSubmissionDeposit(index).method.toHex() }, origin: killer },
    ],
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadOrigin` for each
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(4)
  await check(dispatched)
    .filterEvents()
    .redact()
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('admin origins outside their gate: Dispatched events')
  for (const { event } of dispatched) {
    assert(client.api.events.scheduler.Dispatched.is(event))
    assert(event.data.result.isErr, 'expected the dispatch to fail')
    expect(event.data.result.asErr.isBadOrigin, `expected BadOrigin, got ${event.data.result.asErr.type}`).toBe(true)
  }

  // 4. Still ongoing, deposits still reserved
  const status = await ongoingStatus(client, index)
  expect(status.decisionDeposit.isSome).toBe(true)
  expect(await referendumEvents(client, index, 'Cancelled', 'Killed')).toHaveLength(0)
  expect(await getReservedFunds(client, alice.address)).toBe(submissionDeposit)
  expect(await getReservedFunds(client, bob.address)).toBe(decisionDeposit)
}

/**
 * Calls on a referendum index that was never used fail.
 *
 * Calls that need an ongoing referendum report `NotOngoing`; the refund calls, which first look
 * the referendum up, report `BadReferendum`.
 *
 * 1. Fund an account and take the next unused referendum index
 * 2. Send `place_decision_deposit`, `refund_decision_deposit`, `refund_submission_deposit` and
 *    `set_metadata` for it in one `force_batch`
 * 3. Verify the failures, in call order: `NotOngoing`, `BadReferendum`, `BadReferendum`,
 *    `NotOngoing`
 * 4. Verify nothing was reserved and no referendum was created
 */
async function callsOnUnknownReferendumFail(client: Client<any, any>) {
  const { bob } = testAccounts

  // 1. The next unused index
  await fundAccounts(client, bob)
  const unknownIndex = (await client.api.query.referenda.referendumCount()).toNumber()
  expect((await client.api.query.referenda.referendumInfoFor(unknownIndex)).isNone).toBe(true)

  // 2. Four calls on the unused index
  const anyHash = blake2AsHex(stringToHex('referenda e2e unknown referendum'), 256)
  await sendTransaction(
    client.api.tx.utility
      .forceBatch([
        client.api.tx.referenda.placeDecisionDeposit(unknownIndex),
        client.api.tx.referenda.refundDecisionDeposit(unknownIndex),
        client.api.tx.referenda.refundSubmissionDeposit(unknownIndex),
        client.api.tx.referenda.setMetadata(unknownIndex, anyHash),
      ])
      .signAsync(bob),
  )
  await client.dev.newBlock()

  // 3. The failures, in call order
  await checkSystemEvents(client, 'utility').toMatchSnapshot('unknown referendum: force_batch events')
  const events = await client.api.query.system.events()
  const itemsFailed = events.filter(({ event }) => client.api.events.utility.ItemFailed.is(event))
  const expectedErrors = ['NotOngoing', 'BadReferendum', 'BadReferendum', 'NotOngoing']
  expect(itemsFailed).toHaveLength(expectedErrors.length)
  itemsFailed.forEach(({ event }, position) => {
    assert(client.api.events.utility.ItemFailed.is(event))
    const { error } = event.data
    assert(error.isModule, `expected a module error, got ${error.type}`)
    const expected = expectedErrors[position]
    expect((client.api.errors.referenda as any)[expected].is(error.asModule), `item ${position}: ${expected}`).toBe(
      true,
    )
  })

  // 4. Nothing reserved, no referendum created
  expect(await getReservedFunds(client, bob.address)).toBe(0n)
  expect((await client.api.query.referenda.referendumCount()).toNumber()).toBe(unknownIndex)
}

/// -------
/// Test tree
/// -------

export function referendaE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: ReferendaTestConfig): RootTestTree {
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
      {
        kind: 'describe',
        label: 'Submission',
        children: [
          {
            kind: 'test',
            label: 'submit - Submitted, deposit reserved, timeout alarm set',
            testFn: () => submitReservesDepositAndSetsAlarm(client),
          },
          {
            kind: 'test',
            label: 'submit with a proposal origin that has no track - NoTrack',
            testFn: () => submitWithoutTrackFails(client),
          },
          {
            kind: 'test',
            label:
              'submit with a lookup length that differs from the noted preimage - PreimageStoredWithDifferentLength',
            testFn: () => submitLookupWithWrongLengthFails(client),
          },
          {
            kind: 'test',
            label: 'submit without the submission deposit - InsufficientBalance',
            testFn: () => submitWithoutDepositFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Decision deposit',
        children: [
          {
            kind: 'test',
            label: 'place decision deposit - DecisionDepositPlaced, then DecisionStarted once prepared',
            testFn: () => placeDecisionDepositStartsDeciding(client),
          },
          {
            kind: 'test',
            label: 'place decision deposit twice - HasDeposit',
            testFn: () => placeDecisionDepositTwiceFails(client),
          },
          {
            kind: 'test',
            label: "place decision deposit without the track's deposit - InsufficientBalance",
            testFn: () => placeDecisionDepositWithoutFundsFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Deciding slots',
        children: [
          {
            kind: 'test',
            label: 'deposit on a full track - queued, then one_fewer_deciding from Root starts it',
            testFn: () => oneFewerDecidingStartsQueuedReferendum(client),
          },
          {
            kind: 'test',
            label: 'one_fewer_deciding on an unknown track - BadTrack',
            testFn: () => oneFewerDecidingUnknownTrackFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Time-driven transitions',
        children: [
          {
            kind: 'test',
            label: 'nudge from Root just before the undeciding timeout - alarm re-armed, then TimedOut',
            testFn: () => nudgeThenAlarmTimesOutReferendum(client),
          },
          {
            kind: 'test',
            label: 'support gained, then lost, while deciding - ConfirmStarted, then ConfirmAborted',
            testFn: () => confirmationStartsThenAborts(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Cancel and kill',
        children: [
          {
            kind: 'test',
            label: 'cancel a deciding referendum from ReferendumCanceller - Cancelled, slot released next block',
            testFn: () => cancellerCancelsDecidingReferendum(client),
          },
          {
            kind: 'test',
            label: 'kill from ReferendumKiller - Killed, deposits slashed, metadata cleared',
            testFn: () => killerKillsReferendum(client, testConfig),
          },
          {
            kind: 'test',
            label: 'calls on a cancelled referendum from Root - NotOngoing',
            testFn: () => callsOnCancelledReferendumFail(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Refunds',
        children: [
          {
            kind: 'test',
            label: 'refund both deposits of a cancelled referendum from a third party - refunded once, then NoDeposit',
            testFn: () => thirdPartyRefundsCancelledDeposits(client),
          },
          {
            kind: 'test',
            label: 'refund both deposits of a cancelled referendum from Root - refunded to the depositors',
            testFn: () => rootRefundsCancelledDeposits(client),
          },
          {
            kind: 'test',
            label: 'refund decision deposit of an ongoing referendum - NoDeposit, then Unfinished',
            testFn: () => refundOngoingDecisionDepositFails(client),
          },
          {
            kind: 'test',
            label: 'refund deposits of a killed referendum - NoDeposit and BadStatus',
            testFn: () => refundKilledDepositsFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Metadata',
        children: [
          {
            kind: 'test',
            label: 'set and clear metadata by the submitter - MetadataSet, MetadataCleared',
            testFn: () => submitterSetsAndClearsMetadata(client),
          },
          {
            kind: 'test',
            label: 'metadata from another account on an ongoing referendum - NoPermission',
            testFn: () => nonSubmitterMetadataFails(client),
          },
          {
            kind: 'test',
            label: 'set metadata without a noted preimage - PreimageNotExist',
            testFn: () => metadataWithoutPreimageFails(client),
          },
          {
            kind: 'test',
            label: 'metadata of a finished referendum - anyone clears it, nobody sets it',
            testFn: () => finishedReferendumMetadata(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Origins and indices',
        children: [
          {
            kind: 'test',
            label: 'Root-gated and admin-gated calls from a signed origin - BadOrigin',
            testFn: () => signedOriginRejectedByGatedCalls(client),
          },
          {
            kind: 'test',
            label: 'signed-only calls from Root - BadOrigin',
            testFn: () => rootRejectedBySignedCalls(client),
          },
          {
            kind: 'test',
            label: 'admin origins outside their gate - BadOrigin',
            testFn: () => adminOriginsOutsideTheirGateRejected(client),
          },
          {
            kind: 'test',
            label: 'calls on an unknown referendum - NotOngoing and BadReferendum',
            testFn: () => callsOnUnknownReferendumFail(client),
          },
        ],
      },
    ],
  }
}
