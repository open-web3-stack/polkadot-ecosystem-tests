import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client } from '@e2e-test/shared'

import type { EventRecord } from '@polkadot/types/interfaces'
import type { Codec } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkEvents, getBlockNumber, sortAddressesByBytes, type TestConfig } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/**
 * E2E tests for `pallet-recovery` (modernised in paritytech/polkadot-sdk#10482).
 *
 * The pallet lets a lost account define one or more friend groups; each group
 * has a threshold of friends needed to initiate recovery, an inheritance delay,
 * a cancel delay, and a designated inheritor. Once a group reaches its threshold
 * and the delay has elapsed, anyone can finish the attempt and the inheritor
 * gains access to the lost account via `control_inherited_account`.
 *
 * Groups have an `inheritancePriority` field: lower numbers take precedence
 * over higher ones. A finished higher-priority group displaces an existing
 * lower-priority inheritor; a lower-priority group attempting to finish after a
 * higher-priority one has succeeded gets `AttemptDiscarded` (not an error).
 *
 * The slash path lets the lost account burn the initiator's `SecurityDeposit`
 * if it can reach the chain within the cancel window — the cancel delay exists
 * specifically to prevent initiators from frontrunning a slash with a cancel.
 *
 * All tests target Asset Hub Westend. The pallet's `BlockNumberProvider` is
 * `RelaychainDataProvider<Runtime>`, so the delays are measured in relay-chain
 * block numbers. On AHW with async backing, each `dev.newBlock()` advances the
 * relay block count by `BLOCK_PROCESSING_VELOCITY + RELAY_PARENT_OFFSET = 4`.
 */

/**
 * The return type of `sendTransaction` from `@acala-network/chopsticks-testing`.
 * Not exported by the chopsticks package; reconstructed here to keep helpers
 * typed against the exact shape rather than `any`.
 */
type TxResult = { events: Promise<Codec[]> }

/**
 * Helpers in this module accept either a freshly resolved event array or the
 * raw transaction result. `getEventRecords` normalises both into `EventRecord[]`.
 */
type EventSource = TxResult | EventRecord[]

const UNIT = 1_000_000_000_000n

// Both delays are per-group user parameters, not runtime constants.
// AHW has async backing: each dev.newBlock() advances lastRelayChainBlockNumber by 4
// (BLOCK_PROCESSING_VELOCITY=3 + RELAY_PARENT_OFFSET=1), so delays must be
// even and small enough that the advance is predictable.
const INHERITANCE_DELAY = 2 // satisfied by 1 × newBlock()
const CANCEL_DELAY = 2 // satisfied by 1 × newBlock()

type RecoveryGroupConfig = {
  friends: string[]
  friendsNeeded: number
  inheritor: string
  inheritanceDelay?: number // defaults to INHERITANCE_DELAY
  inheritancePriority: number // lower = higher priority; 0 displaces 1
  cancelDelay?: number // defaults to CANCEL_DELAY
}

/**
 * Re-encode an address into the chain's SS58 format.
 *
 * Events returned by the chain encode addresses with the chain's SS58 prefix
 * (42 for AHW). Test accounts are imported as raw substrate addresses, so
 * direct string comparison against event data fails unless both sides are
 * normalised to the same encoding.
 */
function normalizeAddress<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, address: string) {
  return encodeAddress(address, client.config.properties.addressEncoding)
}

/**
 * Build a `FriendGroup` object suitable for passing to `set_friend_groups`.
 *
 * The `friends` list is sorted by raw bytes because the pallet indexes
 * approvals by position in this list. Out-of-order friends would silently
 * misattribute approvals during voting.
 */
function buildGroup<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, config: RecoveryGroupConfig) {
  return {
    friends: sortAddressesByBytes(config.friends, client.config.properties.addressEncoding),
    friendsNeeded: config.friendsNeeded,
    inheritor: config.inheritor,
    inheritanceDelay: config.inheritanceDelay ?? INHERITANCE_DELAY,
    inheritancePriority: config.inheritancePriority,
    cancelDelay: config.cancelDelay ?? CANCEL_DELAY,
  }
}

/** Read the full `system.account` storage entry for an address. */
async function getAccount<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, address: string) {
  return await client.api.query.system.account(address)
}

/** Read just the free balance for an address, as a bigint. */
async function getFreeBalance<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, address: string): Promise<bigint> {
  return (await getAccount(client, address)).data.free.toBigInt()
}

/**
 * Read the current value of the pallet's `BlockNumberProvider`.
 *
 * On AHW this is `RelaychainDataProvider`, so the value is a relay-chain block
 * number — *not* the local parachain block number. All pallet timing decisions
 * (inheritance delay, cancel delay) are measured in this unit.
 */
async function getProvidedBlockNumber<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>): Promise<number> {
  return await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
}

/**
 * Produce blocks until the provided block number reaches `target`.
 *
 * Returns `{ current, iterations }` so callers can confirm the loop did make
 * progress. Bounded at 10 iterations as a runaway-loop safety net — any real
 * delay in these tests should be reachable in 1–2 iterations given the +4
 * relay block advance per parachain block on AHW with async backing.
 */
async function advanceUntilAtLeast<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, target: number) {
  let current = await getProvidedBlockNumber(client)
  let iterations = 0

  while (current < target) {
    await client.dev.newBlock()
    current = await getProvidedBlockNumber(client)
    iterations += 1
    expect(iterations, `provided block number did not reach target ${target}`).toBeLessThanOrEqual(10)
  }

  return { current, iterations }
}

/**
 * Read the `Attempt` storage entry for a (lost, group) pair.
 *
 * Returns `null` if there's no active attempt. The `as any` cast is necessary
 * because `pallet-recovery` is not yet covered by `@polkadot/api` codegen.
 */
async function getAttempt<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, lost: string, friendGroupIndex: number) {
  const attempt = await (client.api.query.recovery as any).attempt(lost, friendGroupIndex)
  return attempt.isSome ? attempt.unwrap() : null
}

/**
 * Decode a recovery attempt into a plain JS object.
 *
 * The stored value is a `(Attempt, AttemptTicket, SecurityDeposit)` tuple;
 * the test surface only ever cares about the first element. Returns `null` if
 * no attempt exists.
 */
async function getAttemptState<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, lost: string, friendGroupIndex: number) {
  const attempt = await getAttempt(client, lost, friendGroupIndex)
  if (!attempt) {
    return null
  }

  const state = attempt[0]

  return {
    initiator: state.initiator.toString(),
    initBlock: state.initBlock.toNumber(),
    lastApprovalBlock: state.lastApprovalBlock.toNumber(),
    approvals: state.approvals,
  }
}

/**
 * Read the `Inheritor` entry for a lost account and decode the priority/inheritor pair.
 *
 * The stored value is a `(InheritancePriority, AccountId, InheritorTicket)`
 * tuple; the ticket is opaque storage-deposit accounting that tests don't
 * need to inspect. Returns `null` if no inheritor is set.
 */
async function getInheritorState<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, lost: string) {
  const inheritor = await (client.api.query.recovery as any).inheritor(lost)
  if (inheritor.isNone) {
    return null
  }

  const tuple = inheritor.unwrap()

  return {
    order: tuple[0].toNumber(),
    inheritor: tuple[1].toString(),
  }
}

/**
 * Normalise a `sendTransaction` result or raw event array into `EventRecord[]`.
 *
 * `sendTransaction` returns `{ events: Promise<Codec[]> }`; assertions in this
 * module also operate on event arrays they receive directly. This helper accepts
 * both so callers don't have to remember which form they're holding.
 */
async function getEventRecords(resultOrEvents: EventSource): Promise<EventRecord[]> {
  const raw = Array.isArray(resultOrEvents) ? resultOrEvents : await (resultOrEvents as TxResult).events
  return raw as unknown as EventRecord[]
}

/**
 * Find a single event matching `predicate`, asserting it exists.
 *
 * The predicate is the polkadot-js event guard (e.g.
 * `api.events.recovery.AttemptInitiated.is`). The `message` is used in the
 * vitest failure message when the event is absent.
 */
async function findEvent(resultOrEvents: EventSource, predicate: (event: any) => boolean, message: string) {
  const events = await getEventRecords(resultOrEvents)
  const event = events.find(({ event }) => predicate(event))
  expect(event, message).toBeDefined()
  return event!
}

/**
 * Extract named fields from pallet-recovery event data.
 *
 * pallet-recovery has no generated TypeScript types in @polkadot/api yet.
 * All event data field accesses are funnelled through this helper to contain
 * the necessary cast to a single site.
 */
function recoveryEventData(event: EventRecord): Record<string, any> {
  return event.event.data as unknown as Record<string, any>
}

async function expectModuleError<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  client: Client<TCustom, TInitStorages>,
  resultOrEvents: EventSource,
  matcher: (moduleError: any) => boolean,
  message: string,
) {
  const failed = await findEvent(resultOrEvents, (event) => client.api.events.system.ExtrinsicFailed.is(event), message)
  assert(client.api.events.system.ExtrinsicFailed.is(failed.event))
  const dispatchError = failed.event.data.dispatchError
  assert(dispatchError.isModule, 'Expected module error')
  expect(matcher(dispatchError.asModule), message).toBe(true)
}

async function expectProxyExecuted<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, resultOrEvents: EventSource) {
  const proxyExecuted = await findEvent(
    resultOrEvents,
    (event) => client.api.events.proxy.ProxyExecuted.is(event),
    'Expected proxy execution event',
  )
  assert(client.api.events.proxy.ProxyExecuted.is(proxyExecuted.event))
  return proxyExecuted.event.data
}

async function configureSingleGroup<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, group: RecoveryGroupConfig) {
  const tx = client.api.tx.recovery.setFriendGroups([buildGroup(client, group)])
  const events = await sendTransaction(tx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  return events
}

async function configureGroups<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, groups: RecoveryGroupConfig[]) {
  const tx = client.api.tx.recovery.setFriendGroups(groups.map((group) => buildGroup(client, group)))
  const events = await sendTransaction(tx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  return events
}

// Drives a friend group all the way to a completed recovery.
// The initiator is approvers[0]; they both initiate and approve.
// By the time this returns, the Inheritor storage entry is set.
async function completeRecovery<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, friendGroupIndex: number, approvers: (typeof testAccounts.bob)[]) {
  const lost = testAccounts.alice.address
  const initiator = approvers[0]

  await sendTransaction(client.api.tx.recovery.initiateAttempt(lost, friendGroupIndex).signAsync(initiator))
  await client.dev.newBlock()

  for (const approver of approvers) {
    await sendTransaction(client.api.tx.recovery.approveAttempt(lost, friendGroupIndex).signAsync(approver))
    await client.dev.newBlock()
  }

  const attempt = await getAttemptState(client, lost, friendGroupIndex)
  expect(attempt).not.toBeNull()
  // initBlock is the relay block number stored by the pallet during initiation;
  // we advance until the relay block count satisfies the inheritance delay.
  await advanceUntilAtLeast(client, attempt!.initBlock + INHERITANCE_DELAY)

  const finishEvents = await sendTransaction(
    client.api.tx.recovery.finishAttempt(lost, friendGroupIndex).signAsync(initiator),
  )
  await client.dev.newBlock()
  return finishEvents
}

/**
 * Full happy-path lifecycle: Alice configures a friend group, Bob initiates a
 * recovery attempt, Bob and Charlie approve, the inheritance delay elapses,
 * Bob finishes the attempt, Eve becomes the inheritor and successfully
 * dispatches a transfer from Alice's account.
 */
async function fullLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  // 1. Alice configures a 2-of-3 friend group with Eve as inheritor
  const setGroupEvents = await configureSingleGroup(client, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await checkEvents(setGroupEvents, 'recovery').toMatchSnapshot('events when Alice sets friend groups')

  // 2. Bob initiates a recovery attempt on Alice's account
  const initiateEvents = await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await checkEvents(initiateEvents, 'recovery').toMatchSnapshot('events when Bob initiates recovery attempt')

  // Verify the AttemptInitiated event carries the expected lost/initiator/group
  const initiated = await findEvent(
    initiateEvents,
    (event) => client.api.events.recovery.AttemptInitiated.is(event),
    'Expected AttemptInitiated event',
  )
  assert(client.api.events.recovery.AttemptInitiated.is(initiated.event))
  expect(recoveryEventData(initiated).lost.toString()).toBe(normalizeAddress(client, alice.address))
  expect(recoveryEventData(initiated).initiator.toString()).toBe(normalizeAddress(client, bob.address))
  expect(recoveryEventData(initiated).friendGroupIndex.toNumber()).toBe(0)

  // 3. Bob approves the attempt
  const approveByBobEvents = await sendTransaction(
    client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await checkEvents(approveByBobEvents, 'recovery').toMatchSnapshot('events when Bob approves recovery attempt')

  // 4. Charlie approves, reaching the threshold of 2
  const approveByCharlieEvents = await sendTransaction(
    client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(approveByCharlieEvents, 'recovery').toMatchSnapshot('events when Charlie approves recovery attempt')

  // 5. Advance past the inheritance delay
  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, attempt!.initBlock + INHERITANCE_DELAY)

  // 6. Bob finishes the attempt, setting Eve as the inheritor
  const finishEvents = await sendTransaction(client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await checkEvents(finishEvents, 'recovery').toMatchSnapshot('events when Bob finishes recovery attempt')

  // Verify AttemptFinished, no previous inheritor (first finish), and Eve is in storage
  const finished = await findEvent(
    finishEvents,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected AttemptFinished event',
  )
  assert(client.api.events.recovery.AttemptFinished.is(finished.event))
  expect(recoveryEventData(finished).previousInheritor.isNone).toBe(true)
  expect(recoveryEventData(finished).inheritor.toString()).toBe(normalizeAddress(client, eve.address))
  const inheritor = await getInheritorState(client, alice.address)
  expect(inheritor).not.toBeNull()
  expect(inheritor!.order).toBe(0)
  expect(inheritor!.inheritor).toBe(normalizeAddress(client, eve.address))

  // 7. Eve dispatches a transfer from Alice's account via control_inherited_account
  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const controlCall = client.api.tx.balances.transferKeepAlive(ferdie.address, 10n * UNIT)
  const controlEvents = await sendTransaction(
    client.api.tx.recovery.controlInheritedAccount(alice.address, controlCall).signAsync(eve),
  )
  await client.dev.newBlock()
  await checkEvents(controlEvents, 'recovery', { section: 'balances', method: 'Transfer' }).toMatchSnapshot(
    'events when Eve controls recovered account',
  )

  // Verify the inner call succeeded and Ferdie received the funds
  const controlled = await findEvent(
    controlEvents,
    (event) => client.api.events.recovery.RecoveredAccountControlled.is(event),
    'Expected RecoveredAccountControlled event',
  )
  assert(client.api.events.recovery.RecoveredAccountControlled.is(controlled.event))
  expect(recoveryEventData(controlled).callResult.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + 10n * UNIT)
}

/**
 * The initiator can cancel their own attempt, but only after the
 * `cancelDelay` has elapsed since `lastApprovalBlock`. This test confirms a
 * cancel succeeds at the boundary; the failure-tree counterpart confirms it
 * fails before the boundary.
 */
async function initiatorCancelsAfterDelayTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie } = testAccounts

  // 1. Alice configures a 2-of-2 group with the default small cancelDelay
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: testAccounts.eve.address,
    inheritancePriority: 0,
    cancelDelay: CANCEL_DELAY,
  })

  // 2. Bob initiates the attempt
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  // 3. Wait until cancelDelay relay blocks have passed since the last approval
  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, attempt!.lastApprovalBlock + CANCEL_DELAY)

  // 4. Bob cancels — succeeds, AttemptCanceled emitted with Bob as canceler
  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const canceled = await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled event',
  )
  assert(client.api.events.recovery.AttemptCanceled.is(canceled.event))
  expect(recoveryEventData(canceled).canceler.toString()).toBe(normalizeAddress(client, bob.address))
  expect(await getAttempt(client, alice.address, 0)).toBeNull()
}

/**
 * The lost account is exempt from `cancelDelay` — it can cancel any attempt
 * against itself immediately, before any blocks have elapsed. This is the
 * counterpart to the initiator path and exercises the cancel guard from the
 * other side.
 */
async function lostAccountCancelsImmediatelyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // 1. Alice configures a group with a non-trivial cancelDelay (4 relay blocks)
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 4,
  })

  // 2. Bob initiates the attempt
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  // 3. Alice cancels immediately — succeeds despite zero blocks elapsed,
  //    because the cancelDelay guard does not apply to the lost account
  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(alice))
  await client.dev.newBlock()

  const canceled = await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled event',
  )
  assert(client.api.events.recovery.AttemptCanceled.is(canceled.event))
  expect(recoveryEventData(canceled).canceler.toString()).toBe(normalizeAddress(client, alice.address))
  expect(await getAttempt(client, alice.address, 0)).toBeNull()
}

/**
 * The lost account can slash an ongoing attempt, burning the initiator's
 * `SecurityDeposit`. `slashAttempt` takes only the friend group index; the
 * lost account is inferred from the signed origin (which is why the
 * signature differs from `cancelAttempt(lost, idx)`).
 */
async function lostAccountSlashesAttemptTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // Snapshot Bob's free balance before he initiates so we can detect the slash
  const bobFreeBefore = await getFreeBalance(client, bob.address)

  // 1. Alice configures a 2-of-2 friend group
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  // 2. Bob initiates the attempt, putting up the SecurityDeposit
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  // 3. Alice slashes the attempt — origin is the lost account
  const slashEvents = await sendTransaction(client.api.tx.recovery.slashAttempt(0).signAsync(alice))
  await client.dev.newBlock()

  // 4. AttemptSlashed emitted, storage cleared, Bob's balance permanently reduced
  await findEvent(
    slashEvents,
    (event) => client.api.events.recovery.AttemptSlashed.is(event),
    'Expected AttemptSlashed event',
  )
  expect(await getAttempt(client, alice.address, 0)).toBeNull()
  expect(await getFreeBalance(client, bob.address)).toBeLessThan(bobFreeBefore)
}

/**
 * Every fresh approval resets the cancel timer by updating
 * `lastApprovalBlock`. This is the key anti-frontrunning property of the
 * slash window: a late approval before the slash extends the time the lost
 * account has to react.
 */
async function approvalResetsTimerTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, dave, eve } = testAccounts

  // 1. Configure a group with a long cancelDelay (20 relay blocks)
  //    so we can observe both pre- and post-reset cancel attempts
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 20,
  })

  // 2. Bob initiates the attempt
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  // 3. Advance a small amount (still well within the cancel window)
  const initialAttempt = await getAttemptState(client, alice.address, 0)
  expect(initialAttempt).not.toBeNull()
  await advanceUntilAtLeast(client, initialAttempt!.lastApprovalBlock + 2)

  // 4. Charlie approves — this resets lastApprovalBlock to the current block
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  const approvedAttempt = await getAttemptState(client, alice.address, 0)
  expect(approvedAttempt).not.toBeNull()

  // 5. Bob's immediate cancel attempt fails — the clock just restarted
  const failedCancelEvents = await sendTransaction(
    client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedCancelEvents,
    (moduleError) => client.api.errors.recovery.NotYetCancelable.is(moduleError),
    'Expected NotYetCancelable after approval reset the timer',
  )

  // 6. After waiting the full cancelDelay since the new lastApprovalBlock,
  //    Bob can cancel successfully
  await advanceUntilAtLeast(client, approvedAttempt!.lastApprovalBlock + 20)
  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled event',
  )
}

/**
 * Inheritance priority resolution: three groups with priorities 1, 2, 0 all
 * reach threshold before any of them finish, then finish in the order they
 * were initiated. The middle priority displaces the first (because 2 > 1,
 * lower-priority is discarded), then priority 0 displaces the inheritor set
 * by priority 1.
 *
 * All three groups must achieve threshold before any of them finish:
 * `initiate_attempt` is rejected with `HigherPriorityRecovered` once a
 * higher-priority group has set the inheritor.
 */
async function inheritanceOrderConflictTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  // 1. Alice configures three groups with priorities 1, 2, 0 (in that storage order)
  await configureGroups(client, [
    { friends: [bob.address, charlie.address], friendsNeeded: 2, inheritor: eve.address, inheritancePriority: 1 },
    { friends: [dave.address, ferdie.address], friendsNeeded: 2, inheritor: ferdie.address, inheritancePriority: 2 },
    { friends: [charlie.address, dave.address], friendsNeeded: 2, inheritor: bob.address, inheritancePriority: 0 },
  ])

  // 2. All three groups reach threshold before any finish — done first so the
  //    priority-2 (lowest) initiation isn't blocked by a higher-priority finish
  for (const [groupIdx, [initiator, approver]] of [
    [0, [bob, charlie]],
    [1, [dave, ferdie]],
    [2, [charlie, dave]],
  ] as const) {
    await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, groupIdx).signAsync(initiator))
    await client.dev.newBlock()
    await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, groupIdx).signAsync(initiator))
    await client.dev.newBlock()
    await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, groupIdx).signAsync(approver))
    await client.dev.newBlock()
  }

  // 3. Advance past inheritance delay (use the latest attempt's initBlock)
  const latestAttempt = await getAttemptState(client, alice.address, 2)
  expect(latestAttempt).not.toBeNull()
  await advanceUntilAtLeast(client, latestAttempt!.initBlock + INHERITANCE_DELAY)

  // 4. Finish priority 1 first — first finish, no previous inheritor, Eve takes over
  const finishOrder1Events = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  const firstFinished = await findEvent(
    finishOrder1Events,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected first AttemptFinished event',
  )
  assert(client.api.events.recovery.AttemptFinished.is(firstFinished.event))
  expect(recoveryEventData(firstFinished).previousInheritor.isNone).toBe(true)
  expect(recoveryEventData(firstFinished).inheritor.toString()).toBe(normalizeAddress(client, eve.address))
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(client, eve.address))

  // 5. Finish priority 2 — lower priority than 1, so AttemptDiscarded
  //    (not AttemptFinished); existing inheritor (Eve) is unchanged
  const finishOrder2Events = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 1).signAsync(dave),
  )
  await client.dev.newBlock()
  const discarded = await findEvent(
    finishOrder2Events,
    (event) => client.api.events.recovery.AttemptDiscarded.is(event),
    'Expected AttemptDiscarded event',
  )
  assert(client.api.events.recovery.AttemptDiscarded.is(discarded.event))
  expect(recoveryEventData(discarded).existingInheritor.toString()).toBe(normalizeAddress(client, eve.address))
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(client, eve.address))

  // 6. Finish priority 0 — highest priority, displaces Eve with Bob;
  //    AttemptFinished carries previousInheritor = Eve
  const finishOrder0Events = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 2).signAsync(charlie),
  )
  await client.dev.newBlock()
  const displaced = await findEvent(
    finishOrder0Events,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected displacement AttemptFinished event',
  )
  assert(client.api.events.recovery.AttemptFinished.is(displaced.event))
  expect(recoveryEventData(displaced).previousInheritor.isSome).toBe(true)
  expect(recoveryEventData(displaced).previousInheritor.unwrap().toString()).toBe(normalizeAddress(client, eve.address))
  expect(recoveryEventData(displaced).inheritor.toString()).toBe(normalizeAddress(client, bob.address))
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(client, bob.address))
}

/**
 * The lost account can revoke an inheritor at any time after recovery
 * completes. Once revoked, the inheritor's storage is cleared and further
 * `control_inherited_account` calls return `NoInheritor`.
 */
async function revokeInheritorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // 1. Configure a single group and run the recovery to completion
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, 0, [bob, charlie])

  // 2. Alice revokes Eve as inheritor — InheritorRevoked emitted, storage cleared
  const revokeEvents = await sendTransaction(client.api.tx.recovery.revokeInheritor().signAsync(alice))
  await client.dev.newBlock()

  await findEvent(
    revokeEvents,
    (event) => client.api.events.recovery.InheritorRevoked.is(event),
    'Expected InheritorRevoked event',
  )
  expect(await getInheritorState(client, alice.address)).toBeNull()

  // 3. Eve tries to control Alice's account post-revoke and gets NoInheritor
  const failedControlEvents = await sendTransaction(
    client.api.tx.recovery
      .controlInheritedAccount(alice.address, client.api.tx.system.remark('after revoke'))
      .signAsync(eve),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedControlEvents,
    (moduleError) => client.api.errors.recovery.NoInheritor.is(moduleError),
    'Expected NoInheritor after revoke',
  )
}

/**
 * The inheritor relationship survives a failed inner dispatch.
 * `RecoveredAccountControlled` is emitted with `call_result = Err(...)` and
 * the inheritor remains in storage, so a follow-up call can still succeed.
 * This guards against any future change that would consume the inheritor on
 * failure.
 */
async function controlInheritedAccountFailingCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve, ferdie } = testAccounts

  // 1. Configure a group and complete the recovery
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, 0, [bob, charlie])

  // 2. Eve dispatches a transfer of 10,000 UNIT — Alice doesn't have it, so it fails
  const failingCall = client.api.tx.balances.transferKeepAlive(ferdie.address, 10_000n * UNIT)
  const failedControlEvents = await sendTransaction(
    client.api.tx.recovery.controlInheritedAccount(alice.address, failingCall).signAsync(eve),
  )
  await client.dev.newBlock()

  // 3. RecoveredAccountControlled emitted with Err result; Eve is still the inheritor
  const failedControl = await findEvent(
    failedControlEvents,
    (event) => client.api.events.recovery.RecoveredAccountControlled.is(event),
    'Expected RecoveredAccountControlled event for failing inner call',
  )
  assert(client.api.events.recovery.RecoveredAccountControlled.is(failedControl.event))
  expect(recoveryEventData(failedControl).callResult.isErr).toBe(true)
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(client, eve.address))

  // 4. Eve dispatches a transfer of 1 UNIT — succeeds, proving the relationship persists
  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const successfulCall = client.api.tx.balances.transferKeepAlive(ferdie.address, UNIT)
  const successfulControlEvents = await sendTransaction(
    client.api.tx.recovery.controlInheritedAccount(alice.address, successfulCall).signAsync(eve),
  )
  await client.dev.newBlock()

  const successfulControl = await findEvent(
    successfulControlEvents,
    (event) => client.api.events.recovery.RecoveredAccountControlled.is(event),
    'Expected RecoveredAccountControlled event for successful inner call',
  )
  assert(client.api.events.recovery.RecoveredAccountControlled.is(successfulControl.event))
  expect(recoveryEventData(successfulControl).callResult.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + UNIT)
}

/**
 * `control_inherited_account` is callable through an `Any` proxy.
 * This is the complement to the NonTransfer-proxy test: Any proxies are
 * unrestricted, so this is the baseline expectation.
 */
async function controlInheritedAccountAnyProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  // 1. Configure a group, complete the recovery
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, 0, [bob, charlie])

  // 2. Eve adds Bob as an Any-type proxy
  await sendTransaction(client.api.tx.proxy.addProxy(bob.address, 'Any', 0).signAsync(eve))
  await client.dev.newBlock()

  // 3. Bob, acting as Eve's proxy, dispatches control_inherited_account
  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const innerCall = client.api.tx.recovery.controlInheritedAccount(
    alice.address,
    client.api.tx.balances.transferKeepAlive(ferdie.address, UNIT),
  )
  const proxyEvents = await sendTransaction(client.api.tx.proxy.proxy(eve.address, null, innerCall).signAsync(bob))
  await client.dev.newBlock()

  // 4. ProxyExecuted carries Ok; the inner balance transfer landed
  const proxyExecuted = await expectProxyExecuted(client, proxyEvents)
  expect(proxyExecuted.result.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + UNIT)
}

/**
 * `finish_attempt` succeeds at exactly `inheritanceDelay` relay blocks past
 * `initBlock`. Guards against an off-by-one where the comparison is `>`
 * instead of `>=`.
 */
async function finishAttemptAtExactBoundaryTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // 1. Configure a group with inheritanceDelay = 2 (reachable with 1 newBlock())
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    inheritanceDelay: 2,
  })

  // 2. Bob initiates and Bob+Charlie approve (reach threshold)
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  // 3. Advance to exactly initBlock + 2 (the boundary)
  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, attempt!.initBlock + 2)

  // 4. Finish succeeds at the boundary
  const finishEvents = await sendTransaction(client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    finishEvents,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected AttemptFinished at exact boundary',
  )
}

/**
 * `cancel_attempt` succeeds at exactly `cancelDelay` relay blocks past
 * `lastApprovalBlock`. The off-by-one counterpart to the finish boundary test.
 */
async function cancelAttemptAtExactBoundaryTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // 1. Configure a group with cancelDelay = 2
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 2,
  })

  // 2. Bob initiates the attempt
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  // 3. Advance to exactly lastApprovalBlock + 2 (the boundary)
  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, attempt!.lastApprovalBlock + 2)

  // 4. Cancel succeeds at the boundary
  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled at exact boundary',
  )
}

/**
 * An odd `inheritanceDelay` is still reachable within 2 newBlock() calls
 * because each call advances the relay block count by 4 (so 3 is reached
 * after 1 call). Bounded explicitly to catch any regression that would force
 * extra block production.
 */
async function finishAttemptOddDelayTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // 1. Configure a group with an odd inheritanceDelay = 3
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    inheritanceDelay: 3,
  })

  // 2. Reach threshold
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  // 3. Advance to initBlock + 3; assert the loop took at most 2 iterations
  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  const { iterations } = await advanceUntilAtLeast(client, attempt!.initBlock + 3)
  expect(iterations).toBeLessThanOrEqual(2)

  // 4. Finish succeeds despite the odd delay
  const finishEvents = await sendTransaction(client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    finishEvents,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected AttemptFinished for odd delay',
  )
}

/**
 * An initiator who tries to cancel their own attempt before the cancelDelay
 * has elapsed is rejected with `NotYetCancelable`. The counterpart to
 * `initiatorCancelsAfterDelayTest`.
 */
async function cancelBeforeDelayFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // 1. Configure a group with a long cancelDelay so it can't be hit by accident
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 20,
  })

  // 2. Bob initiates and immediately tries to cancel
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  // 3. The cancel fails with NotYetCancelable
  const failedCancelEvents = await sendTransaction(
    client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedCancelEvents,
    (moduleError) => client.api.errors.recovery.NotYetCancelable.is(moduleError),
    'Expected NotYetCancelable',
  )
}

/**
 * The lost account cannot mutate its friend groups while any recovery
 * attempt against it is active. Prevents Alice from defeating an ongoing
 * recovery by replacing the friend list out from under it.
 */
async function setFriendGroupsWithActiveAttemptFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, dave, eve } = testAccounts

  // 1. Alice configures a group
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  // 2. Bob initiates an attempt against Alice
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  // 3. Alice tries to replace her friend groups — rejected with HasOngoingAttempts
  const failedSetGroupEvents = await sendTransaction(
    client.api.tx.recovery
      .setFriendGroups([
        buildGroup(client, {
          friends: [charlie.address, dave.address],
          friendsNeeded: 2,
          inheritor: eve.address,
          inheritancePriority: 0,
        }),
      ])
      .signAsync(alice),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedSetGroupEvents,
    (moduleError) => client.api.errors.recovery.HasOngoingAttempts.is(moduleError),
    'Expected HasOngoingAttempts',
  )
}

/**
 * Once threshold approvals have landed, a third friend trying to approve
 * gets `AlreadyApproved` — the bitfield is full, no spare slots.
 */
async function thresholdPlusOneApprovalFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, dave, eve } = testAccounts

  // 1. Configure a 2-of-3 group
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  // 2. Bob initiates, Bob and Charlie approve (threshold reached)
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  // 3. Dave's third approval fails with AlreadyApproved
  const failedApprovalEvents = await sendTransaction(
    client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(dave),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedApprovalEvents,
    (moduleError) => client.api.errors.recovery.AlreadyApproved.is(moduleError),
    'Expected AlreadyApproved',
  )
}

/**
 * `finish_attempt` is rejected with `NotYetInheritable` if called before
 * `inheritanceDelay` relay blocks have elapsed since `initBlock`, even with
 * threshold approvals in place.
 */
async function finishBeforeDelayFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve } = testAccounts

  // 1. Configure a group with a long inheritanceDelay so it can't be reached accidentally
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    inheritanceDelay: 20,
  })

  // 2. Reach threshold without advancing past the delay
  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  // 3. Bob tries to finish — rejected with NotYetInheritable
  const failedFinishEvents = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedFinishEvents,
    (moduleError) => client.api.errors.recovery.NotYetInheritable.is(moduleError),
    'Expected NotYetInheritable',
  )
}

/**
 * Once a higher-priority group has set the inheritor, lower-priority groups
 * are rejected at `initiate_attempt` with `HigherPriorityRecovered` — there
 * is no point in starting a new attempt that can only result in
 * `AttemptDiscarded`.
 */
async function initiateWhenHigherPriorityRecoveredFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  // 1. Configure two groups: priority 0 (higher) and priority 1 (lower)
  await configureGroups(client, [
    {
      friends: [bob.address, charlie.address],
      friendsNeeded: 2,
      inheritor: eve.address,
      inheritancePriority: 0,
    },
    {
      friends: [dave.address, ferdie.address],
      friendsNeeded: 2,
      inheritor: ferdie.address,
      inheritancePriority: 1,
    },
  ])

  // 2. Complete the priority-0 recovery first — Eve becomes inheritor
  await completeRecovery(client, 0, [bob, charlie])

  // 3. Dave (priority-1 group) tries to initiate — rejected with HigherPriorityRecovered
  const failedInitiateEvents = await sendTransaction(
    client.api.tx.recovery.initiateAttempt(alice.address, 1).signAsync(dave),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedInitiateEvents,
    (moduleError) => client.api.errors.recovery.HigherPriorityRecovered.is(moduleError),
    'Expected HigherPriorityRecovered',
  )
}

/**
 * `initiate_attempt` is restricted to members of the group's friends list.
 * An outsider gets `NotFriend`.
 */
async function notFriendCannotInitiateTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve, ferdie } = testAccounts

  // 1. Configure a group whose friends are Bob and Charlie (no Ferdie)
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  // 2. Ferdie tries to initiate — rejected with NotFriend
  const failedInitiateEvents = await sendTransaction(
    client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(ferdie),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedInitiateEvents,
    (moduleError) => client.api.errors.recovery.NotFriend.is(moduleError),
    'Expected NotFriend',
  )
}

/**
 * `control_inherited_account` is callable through a NonTransfer proxy.
 *
 * The runtime configuration intentionally does *not* exclude this call from
 * the NonTransfer filter, even though it can effectively transfer the lost
 * account's balance. The reasoning is that the inheritor relationship was
 * itself established via the recovery process; if the inheritor wants a
 * proxy to act on its behalf, that's the same security boundary as the
 * inheritor acting directly. This test pins that decision so any future
 * change to the proxy filter requires a deliberate test update.
 */
async function controlInheritedAccountNonTransferProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const { alice, bob, charlie, eve, ferdie } = testAccounts

  // 1. Configure a group, complete the recovery
  await configureSingleGroup(client, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, 0, [bob, charlie])

  // 2. Eve adds Bob as a NonTransfer-type proxy
  await sendTransaction(client.api.tx.proxy.addProxy(bob.address, 'NonTransfer', 0).signAsync(eve))
  await client.dev.newBlock()

  // 3. Bob, acting as Eve's NonTransfer proxy, dispatches control_inherited_account
  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const innerCall = client.api.tx.recovery.controlInheritedAccount(
    alice.address,
    client.api.tx.balances.transferKeepAlive(ferdie.address, UNIT),
  )
  const proxyEvents = await sendTransaction(client.api.tx.proxy.proxy(eve.address, null, innerCall).signAsync(bob))
  await client.dev.newBlock()

  // 4. ProxyExecuted carries Ok and the inner transfer landed
  const proxyExecuted = await expectProxyExecuted(client, proxyEvents)
  expect(proxyExecuted.result.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + UNIT)
}

export function successRecoveryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'success tests',
    children: [
      {
        kind: 'test',
        label: 'full lifecycle: set_friend_groups → initiate → approve × 2 → finish → control',
        testFn: () => fullLifecycleTest(getClient()),
      },
      {
        kind: 'test',
        label: 'initiator cancels attempt after cancel_delay passes',
        testFn: () => initiatorCancelsAfterDelayTest(getClient()),
      },
      {
        kind: 'test',
        label: 'lost account cancels attempt immediately without delay',
        testFn: () => lostAccountCancelsImmediatelyTest(getClient()),
      },
      {
        kind: 'test',
        label: 'lost account slashes attempt — initiator bond is not returned',
        testFn: () => lostAccountSlashesAttemptTest(getClient()),
      },
      {
        kind: 'test',
        label: 'approval resets the cancel timer — slash window extended after each vote',
        testFn: () => approvalResetsTimerTest(getClient()),
      },
      {
        kind: 'test',
        label: 'inheritance order conflict: discard of lower-priority, displacement by higher-priority',
        testFn: () => inheritanceOrderConflictTest(getClient()),
      },
      {
        kind: 'test',
        label: 'revoke_inheritor clears inheritor storage and releases hold',
        testFn: () => revokeInheritorTest(getClient()),
      },
      {
        kind: 'test',
        label: 'control_inherited_account with failing inner call preserves inheritor relationship',
        testFn: () => controlInheritedAccountFailingCallTest(getClient()),
      },
      {
        kind: 'test',
        label: 'control_inherited_account executes successfully through Any proxy',
        testFn: () => controlInheritedAccountAnyProxyTest(getClient()),
      },
      {
        kind: 'test',
        label: 'control_inherited_account passes through NonTransfer proxy — intentionally not excluded',
        testFn: () => controlInheritedAccountNonTransferProxyTest(getClient()),
      },
      {
        kind: 'test',
        label: 'finish_attempt succeeds at exactly inheritance_delay blocks (even delay)',
        testFn: () => finishAttemptAtExactBoundaryTest(getClient()),
      },
      {
        kind: 'test',
        label: 'cancel_attempt succeeds at exactly cancel_delay blocks (even delay)',
        testFn: () => cancelAttemptAtExactBoundaryTest(getClient()),
      },
      {
        kind: 'test',
        label: 'finish_attempt with odd inheritance_delay is reachable within two newBlock() calls',
        testFn: () => finishAttemptOddDelayTest(getClient()),
      },
    ],
  }
}

export function failureRecoveryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(getClient: () => Client<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'failure tests',
    children: [
      {
        kind: 'test',
        label: 'initiator cannot cancel before cancel_delay',
        testFn: () => cancelBeforeDelayFailsTest(getClient()),
      },
      {
        kind: 'test',
        label: 'set_friend_groups fails when attempt is active',
        testFn: () => setFriendGroupsWithActiveAttemptFailsTest(getClient()),
      },
      {
        kind: 'test',
        label: 'approve_attempt fails when threshold already met',
        testFn: () => thresholdPlusOneApprovalFailsTest(getClient()),
      },
      {
        kind: 'test',
        label: 'finish_attempt fails before inheritance_delay',
        testFn: () => finishBeforeDelayFailsTest(getClient()),
      },
      {
        kind: 'test',
        label: 'initiate_attempt fails when higher-priority group already recovered',
        testFn: () => initiateWhenHigherPriorityRecoveredFailsTest(getClient()),
      },
      {
        kind: 'test',
        label: 'non-friend cannot initiate recovery attempt',
        testFn: () => notFriendCannotInitiateTest(getClient()),
      },
    ],
  }
}

/**
 * Default set of recovery end-to-end tests.
 *
 * Creates a single client connected to the target chain in `beforeAll`,
 * snapshots its state, and restores the snapshot between every test so each
 * scenario runs against a clean baseline without paying the cost of a fresh
 * client per test.
 */
export function baseRecoveryE2Etests<
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
    children: [successRecoveryE2ETests(() => client), failureRecoveryE2ETests(() => client)],
  }
}
