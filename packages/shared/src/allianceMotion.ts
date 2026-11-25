/**
 * E2E tests for how the `AllianceMotion` collective identifies a motion.
 *
 * `AllianceMotion` is an instance of `pallet-collective` whose members are the Fellows of the
 * Alliance. A member opens a motion with `propose(threshold, call)`. With a threshold of 2 or more
 * the call is stored and voted on; with a lower threshold it runs at once and nothing is stored.
 * Fellows can also open, vote on and close motions through the `alliance` pallet, which forwards
 * to the collective. `execute` runs a call as a single member, without a motion.
 *
 * Every motion is identified by a hash, which `vote`, `close` and the events carry. Runtimes from
 * `thresholdInProposalHashSince` on derive it from the call and the threshold together, so the
 * same call can be pending under two thresholds at once. Older runtimes derive it from the call
 * alone, and the tests of the newer derivation skip there. `execute` reports the hash of the call
 * alone on every runtime.
 *
 * All block numbers the pallet uses are local, and no test waits on one: a motion can be closed as
 * soon as its ayes reach the threshold.
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client, RootTestTree } from '@e2e-test/shared'

import type { AugmentedEvent, SubmittableExtrinsic } from '@polkadot/api/types'
import type { AnyTuple, IEvent } from '@polkadot/types/types'
import { u8aCmp, u8aConcat } from '@polkadot/util'
import { blake2AsHex } from '@polkadot/util-crypto'

import { assert, expect, type TestContext } from 'vitest'

import { checkSystemEvents, type TestConfig } from './helpers/index.js'

/// -------
/// Constants
/// -------

/**
 * Native balance given to each account the suite signs with, in multiples of the existential
 * deposit. It only has to cover transaction fees: this suite's motions reserve nothing.
 */
const ENDOWMENT_IN_EXISTENTIAL_DEPOSITS = 100_000n

/**
 * Snapshot redaction for the collective's events.
 *
 * The proposal hash is the value under test, so hashes are kept. The proposal index continues
 * from the number of motions the live chain has seen so far, which grows over time, so it is
 * redacted and asserted against `ProposalCount` instead.
 */
const MOTION_EVENT_REDACTION = { hash: false, redactKeys: /^proposalIndex$/ }

/**
 * `AllianceMotion`-specific test parameters.
 */
export interface AllianceMotionTestConfig extends TestConfig {
  /**
   * First spec version of this chain's runtime that derives a motion's hash from the call and the
   * threshold together. Runtimes below it hash the call alone.
   */
  thresholdInProposalHashSince: number
}

/// -------
/// Helpers
/// -------

/**
 * Make alice, bob and charlie the Alliance's Fellows and the members of `AllianceMotion`, and fund
 * them for fees.
 *
 * On a live chain `alliance.init_members` writes both lists and membership changes keep them in
 * step. The suite cannot sign for the live Fellows, so it replaces both lists in storage with
 * accounts it controls. Both are written sorted by account id, as the pallets keep them. Membership
 * is a precondition of every test here and is not itself under test.
 */
async function seedFellows(client: Client<any, any>): Promise<void> {
  const { alice, bob, charlie } = testAccounts
  const fellows = [alice, bob, charlie].sort((a, b) => u8aCmp(a.publicKey, b.publicKey)).map((pair) => pair.address)
  const endowment = client.api.consts.balances.existentialDeposit.toBigInt() * ENDOWMENT_IN_EXISTENTIAL_DEPOSITS

  await client.dev.setStorage({
    System: { account: fellows.map((who) => [[who], { providers: 1, data: { free: endowment } }]) },
    Alliance: { members: [[['Fellow'], fellows]] },
    AllianceMotion: { members: fellows },
  })

  const members = await client.api.query.allianceMotion.members()
  expect(members.map((member) => member.toString())).toEqual(
    fellows.map((who) => client.api.createType('AccountId', who).toString()),
  )
}

/**
 * The call every motion in this suite carries: `alliance.set_rule` with a fixed CID (version 1,
 * raw codec, a sha2-256 multihash with a constant digest).
 *
 * `set_rule` is gated by the Alliance's admin origin, which a motion satisfies only when more than
 * two thirds of the members approved it. With three Fellows, a unanimous motion sets the rule,
 * while a call run on behalf of a single member fails with `BadOrigin`. Both results are reported
 * in the collective's events, so each test can tell which path ran the call.
 */
function setRuleCall(client: Client<any, any>): SubmittableExtrinsic<'promise'> {
  return client.api.tx.alliance.setRule({
    version: 'V1',
    codec: 0x55,
    hash_: { code: 0x12, digest: `0x${'11'.repeat(32)}` },
  })
}

/** The Alliance rule in storage, as JSON, for comparison with the CID a `set_rule` call carries. */
async function allianceRule(client: Client<any, any>): Promise<unknown> {
  return (await client.api.query.alliance.rule()).toJSON()
}

/** Hash of a call alone: `blake2_256` over its SCALE encoding. */
function hashOfCall(call: SubmittableExtrinsic<'promise'>): string {
  return call.method.hash.toHex()
}

/**
 * Hash of a call together with a voting threshold: `blake2_256` over the SCALE encoding of the
 * call followed by the threshold as a fixed-width `u32`.
 *
 * The threshold is four little-endian bytes here, although `propose` takes it compact-encoded.
 */
function hashOfCallAndThreshold(
  client: Client<any, any>,
  call: SubmittableExtrinsic<'promise'>,
  threshold: number,
): string {
  return blake2AsHex(u8aConcat(call.method.toU8a(), client.api.createType('u32', threshold).toU8a()))
}

/** Data of every event of one type in the latest block, in the order they were emitted. */
async function eventsInLastBlock<T extends AnyTuple, N>(
  client: Client<any, any>,
  eventType: AugmentedEvent<'promise', T, N>,
): Promise<IEvent<T, N>['data'][]> {
  const events = await client.api.query.system.events()
  return events.flatMap(({ event }) => (eventType.is(event) ? [event.data] : []))
}

/** Hashes of the motions currently open, in the order the pallet lists them. */
async function openMotions(client: Client<any, any>): Promise<string[]> {
  return (await client.api.query.allianceMotion.proposals()).map((hash) => hash.toHex())
}

/**
 * Assert that the latest block's only failed extrinsic failed with a specific `AllianceMotion`
 * error.
 *
 * `errorName` is looked up on the runtime's own error metadata, so a renamed or removed variant
 * fails the test rather than silently matching nothing.
 */
async function expectAllianceMotionError(client: Client<any, any>, errorName: string): Promise<void> {
  const [failure] = await eventsInLastBlock(client, client.api.events.system.ExtrinsicFailed)
  assert(failure, 'expected an ExtrinsicFailed event')

  const { dispatchError } = failure
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)

  const errors = client.api.errors.allianceMotion as Record<string, { is: (error: unknown) => boolean }>
  assert(errors[errorName], `runtime has no allianceMotion error named ${errorName}`)
  expect(errors[errorName].is(dispatchError.asModule)).toBe(true)
}

/// -------
/// Tests - Proposal identity
/// -------

/**
 * A stored motion is identified by the hash of its call and its threshold together.
 *
 * 1. Seed the Fellows
 * 2. Alice proposes `set_rule` with threshold 2
 * 3. Verify the `Proposed` event: proposer, index and threshold
 * 4. Verify the hash in the event covers the call and the threshold, and is not the hash of the
 *    call alone
 * 5. Verify the motion is stored under that hash, and nothing is stored under the hash of the
 *    call alone
 */
async function proposeHashCoversCallAndThreshold(client: Client<any, any>) {
  const { alice } = testAccounts
  const threshold = 2

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const countBefore = (await client.api.query.allianceMotion.proposalCount()).toNumber()

  // 2. Propose
  const proposeTx = client.api.tx.allianceMotion.propose(threshold, call.method, call.method.encodedLength)
  await sendTransaction(proposeTx.signAsync(alice))
  await client.dev.newBlock()

  // 3. Proposed event
  await checkSystemEvents(client, { section: 'allianceMotion', method: 'Proposed' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('propose with threshold 2: Proposed event')
  const [proposed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Proposed)
  assert(proposed, 'expected a Proposed event')
  expect(proposed.account.eq(alice.address)).toBe(true)
  expect(proposed.proposalIndex.toNumber()).toBe(countBefore)
  expect(proposed.threshold.toNumber()).toBe(threshold)

  // 4. The hash covers the call and the threshold
  const motionHash = proposed.proposalHash.toHex()
  expect(motionHash).toBe(hashOfCallAndThreshold(client, call, threshold))
  expect(motionHash).not.toBe(hashOfCall(call))

  // 5. Stored under that hash only
  const storedCall = await client.api.query.allianceMotion.proposalOf(motionHash)
  expect(storedCall.isSome).toBe(true)
  expect(storedCall.unwrap().toHex()).toBe(call.method.toHex())
  const voting = await client.api.query.allianceMotion.voting(motionHash)
  expect(voting.isSome).toBe(true)
  expect(voting.unwrap().index.toNumber()).toBe(countBefore)
  expect(voting.unwrap().threshold.toNumber()).toBe(threshold)
  expect(await openMotions(client)).toContain(motionHash)

  expect((await client.api.query.allianceMotion.proposalOf(hashOfCall(call))).isNone).toBe(true)
  expect((await client.api.query.allianceMotion.voting(hashOfCall(call))).isNone).toBe(true)
  expect(await openMotions(client)).not.toContain(hashOfCall(call))
}

/**
 * The same call proposed with two thresholds gives two motions, each voted on and closed on its
 * own.
 *
 * 1. Seed the Fellows
 * 2. Alice proposes `set_rule` with threshold 2, then the same call with threshold 3
 * 3. Verify the two `Proposed` events carry different hashes and consecutive indices, and both
 *    motions are open
 * 4. All three Fellows vote aye on the threshold 3 motion
 * 5. Alice closes it: it is approved and executed, and the rule is set
 * 6. Verify the threshold 2 motion is still open with no votes
 */
async function sameCallWithTwoThresholds(client: Client<any, any>) {
  const { alice, bob, charlie } = testAccounts
  const allianceMotion = client.api.tx.allianceMotion

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const length = call.method.encodedLength
  const rule = call.method.args[0].toJSON()
  expect(await allianceRule(client)).not.toEqual(rule)

  // 2. The same call under two thresholds
  await sendTransaction(allianceMotion.propose(2, call.method, length).signAsync(alice))
  await client.dev.newBlock()
  const [lowProposed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Proposed)
  assert(lowProposed, 'expected a Proposed event for threshold 2')

  await sendTransaction(allianceMotion.propose(3, call.method, length).signAsync(alice))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'allianceMotion', method: 'Proposed' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('same call with threshold 3: Proposed event')
  const [highProposed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Proposed)
  assert(highProposed, 'expected a Proposed event for threshold 3')

  // 3. Two separate motions
  const lowHash = lowProposed.proposalHash.toHex()
  const highHash = highProposed.proposalHash.toHex()
  const highIndex = highProposed.proposalIndex.toNumber()
  expect(lowHash).toBe(hashOfCallAndThreshold(client, call, 2))
  expect(highHash).toBe(hashOfCallAndThreshold(client, call, 3))
  expect(highHash).not.toBe(lowHash)
  expect(highIndex).toBe(lowProposed.proposalIndex.toNumber() + 1)
  expect(await openMotions(client)).toEqual(expect.arrayContaining([lowHash, highHash]))

  // 4. Unanimous ayes on the threshold 3 motion
  for (const fellow of [alice, bob, charlie]) {
    await sendTransaction(allianceMotion.vote(highHash, highIndex, true).signAsync(fellow))
  }
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'allianceMotion', method: 'Voted' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('threshold 3 motion: Voted events')
  const voted = await eventsInLastBlock(client, client.api.events.allianceMotion.Voted)
  expect(voted).toHaveLength(3)
  for (const vote of voted) {
    expect(vote.proposalHash.toHex()).toBe(highHash)
    expect(vote.voted.isTrue).toBe(true)
  }
  expect(voted[2].yes.toNumber()).toBe(3)
  expect(voted[2].no.toNumber()).toBe(0)

  // 5. Close the threshold 3 motion
  const { weight } = await call.paymentInfo(alice.address)
  await sendTransaction(allianceMotion.close(highHash, highIndex, weight, length).signAsync(alice))
  await client.dev.newBlock()
  await checkSystemEvents(client, 'allianceMotion', { section: 'alliance', method: 'NewRuleSet' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('threshold 3 motion closed: collective and alliance events')
  const [closed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Closed)
  assert(closed, 'expected a Closed event')
  expect(closed.proposalHash.toHex()).toBe(highHash)
  expect(closed.yes.toNumber()).toBe(3)
  expect(closed.no.toNumber()).toBe(0)
  const [approved] = await eventsInLastBlock(client, client.api.events.allianceMotion.Approved)
  assert(approved, 'expected an Approved event')
  expect(approved.proposalHash.toHex()).toBe(highHash)
  const [executed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Executed)
  assert(executed, 'expected an Executed event')
  expect(executed.proposalHash.toHex()).toBe(highHash)
  expect(executed.result.isOk).toBe(true)
  expect(await allianceRule(client)).toEqual(rule)

  // 6. The threshold 2 motion is untouched
  const openAfter = await openMotions(client)
  expect(openAfter).toContain(lowHash)
  expect(openAfter).not.toContain(highHash)
  expect((await client.api.query.allianceMotion.proposalOf(highHash)).isNone).toBe(true)
  const lowVoting = (await client.api.query.allianceMotion.voting(lowHash)).unwrap()
  expect(lowVoting.threshold.toNumber()).toBe(2)
  expect(lowVoting.ayes).toHaveLength(0)
  expect(lowVoting.nays).toHaveLength(0)
}

/**
 * Proposing a call that is already pending with the same threshold is refused.
 *
 * 1. Seed the Fellows
 * 2. Alice proposes `set_rule` with threshold 2
 * 3. Verify the motion is stored under the hash of the call and threshold 2
 * 4. Bob proposes the same call with threshold 2
 * 5. Verify the call failed with `DuplicateProposal`
 * 6. Verify the open motions and the proposal count did not change
 */
async function proposeSameCallAndThresholdFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const threshold = 2

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const proposeTx = client.api.tx.allianceMotion.propose(threshold, call.method, call.method.encodedLength)

  // 2. First proposal
  await sendTransaction(proposeTx.signAsync(alice))
  await client.dev.newBlock()

  // 3. Stored under the hash of the call and the threshold
  const motionHash = hashOfCallAndThreshold(client, call, threshold)
  const openBefore = await openMotions(client)
  expect(openBefore).toContain(motionHash)
  const countBefore = (await client.api.query.allianceMotion.proposalCount()).toNumber()

  // 4. Same call, same threshold
  await sendTransaction(proposeTx.signAsync(bob))
  await client.dev.newBlock()

  // 5. DuplicateProposal
  await expectAllianceMotionError(client, 'DuplicateProposal')

  // 6. Nothing changed
  expect(await openMotions(client)).toEqual(openBefore)
  expect((await client.api.query.allianceMotion.proposalCount()).toNumber()).toBe(countBefore)
}

/// -------
/// Tests - Immediate execution
/// -------

/**
 * A proposal with threshold 1 runs at once, and its `Executed` event carries the hash of the call
 * and that threshold.
 *
 * The call runs with the origin of one member out of three, which is not more than two thirds, so
 * `set_rule` itself fails with `BadOrigin`. The outer `propose` still succeeds and reports that
 * result.
 *
 * 1. Seed the Fellows
 * 2. Bob proposes `set_rule` with threshold 1
 * 3. Verify the `Executed` event: the hash covers the call and threshold 1, and the result is
 *    `BadOrigin`
 * 4. Verify nothing was stored and the rule did not change
 */
async function proposeWithThresholdOneExecutes(client: Client<any, any>) {
  const { bob } = testAccounts
  const threshold = 1

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const openBefore = await openMotions(client)
  const countBefore = (await client.api.query.allianceMotion.proposalCount()).toNumber()
  const ruleBefore = await allianceRule(client)

  // 2. Propose with threshold 1
  const proposeTx = client.api.tx.allianceMotion.propose(threshold, call.method, call.method.encodedLength)
  await sendTransaction(proposeTx.signAsync(bob))
  await client.dev.newBlock()

  // 3. Executed event
  await checkSystemEvents(client, 'allianceMotion')
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('propose with threshold 1: Executed event')
  const [executed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Executed)
  assert(executed, 'expected an Executed event')
  const executedHash = executed.proposalHash.toHex()
  expect(executedHash).toBe(hashOfCallAndThreshold(client, call, threshold))
  expect(executedHash).not.toBe(hashOfCall(call))
  assert(executed.result.isErr, 'expected the call to fail on its origin')
  expect(executed.result.asErr.isBadOrigin).toBe(true)

  // 4. Nothing stored, rule unchanged
  expect(await openMotions(client)).toEqual(openBefore)
  expect((await client.api.query.allianceMotion.proposalCount()).toNumber()).toBe(countBefore)
  expect((await client.api.query.allianceMotion.proposalOf(executedHash)).isNone).toBe(true)
  expect(await allianceRule(client)).toEqual(ruleBefore)
}

/**
 * A pending motion does not block the immediate execution of the same call under another
 * threshold.
 *
 * 1. Seed the Fellows
 * 2. Alice proposes `set_rule` with threshold 2, which stays pending
 * 3. Bob proposes the same call with threshold 1
 * 4. Verify the second call ran at once: an `Executed` event with its own hash, and no failed
 *    extrinsic
 * 5. Verify the pending motion is untouched
 */
async function immediateExecutionBesidePendingMotion(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const allianceMotion = client.api.tx.allianceMotion

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const length = call.method.encodedLength

  // 2. Pending motion with threshold 2
  await sendTransaction(allianceMotion.propose(2, call.method, length).signAsync(alice))
  await client.dev.newBlock()
  const pendingHash = hashOfCallAndThreshold(client, call, 2)
  const openBefore = await openMotions(client)
  expect(openBefore).toContain(pendingHash)

  // 3. Same call with threshold 1
  await sendTransaction(allianceMotion.propose(1, call.method, length).signAsync(bob))
  await client.dev.newBlock()

  // 4. It ran at once
  await checkSystemEvents(client, 'allianceMotion')
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('threshold 1 beside a pending threshold 2 motion: Executed event')
  expect(await eventsInLastBlock(client, client.api.events.system.ExtrinsicFailed)).toHaveLength(0)
  const [executed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Executed)
  assert(executed, 'expected an Executed event')
  expect(executed.proposalHash.toHex()).toBe(hashOfCallAndThreshold(client, call, 1))
  expect(executed.proposalHash.toHex()).not.toBe(pendingHash)

  // 5. Pending motion untouched
  expect(await openMotions(client)).toEqual(openBefore)
  const pendingVoting = (await client.api.query.allianceMotion.voting(pendingHash)).unwrap()
  expect(pendingVoting.threshold.toNumber()).toBe(2)
  expect(pendingVoting.ayes).toHaveLength(0)
  expect(pendingVoting.nays).toHaveLength(0)
}

/**
 * Immediate execution is refused while a motion with the same call and threshold 1 is pending.
 *
 * `allianceMotion.propose` never stores a motion with a threshold below 2, but `alliance.propose`
 * stores a motion with whatever threshold it is given. That is the one way a threshold 1 motion
 * can be pending.
 *
 * 1. Seed the Fellows
 * 2. Alice opens a threshold 1 motion for `set_rule` through `alliance.propose`
 * 3. Verify the collective's `Proposed` event: threshold 1, and the hash of the call and
 *    threshold 1
 * 4. Bob proposes the same call with threshold 1 through `allianceMotion.propose`
 * 5. Verify the call failed with `DuplicateProposal`
 * 6. Verify the pending motion, the proposal count and the rule did not change
 */
async function immediateExecutionOfPendingThresholdOneMotionFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const threshold = 1

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const length = call.method.encodedLength
  const ruleBefore = await allianceRule(client)

  // 2. Threshold 1 motion through the alliance pallet
  await sendTransaction(client.api.tx.alliance.propose(threshold, call.method, length).signAsync(alice))
  await client.dev.newBlock()

  // 3. Proposed event from the collective
  await checkSystemEvents(client, { section: 'allianceMotion', method: 'Proposed' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('alliance propose with threshold 1: Proposed event')
  const [proposed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Proposed)
  assert(proposed, 'expected a Proposed event')
  expect(proposed.threshold.toNumber()).toBe(threshold)
  const motionHash = proposed.proposalHash.toHex()
  expect(motionHash).toBe(hashOfCallAndThreshold(client, call, threshold))
  const openBefore = await openMotions(client)
  expect(openBefore).toContain(motionHash)
  const countBefore = (await client.api.query.allianceMotion.proposalCount()).toNumber()

  // 4. Same call and threshold, for immediate execution
  await sendTransaction(client.api.tx.allianceMotion.propose(threshold, call.method, length).signAsync(bob))
  await client.dev.newBlock()

  // 5. DuplicateProposal
  await expectAllianceMotionError(client, 'DuplicateProposal')

  // 6. Nothing changed
  expect(await openMotions(client)).toEqual(openBefore)
  expect((await client.api.query.allianceMotion.proposalCount()).toNumber()).toBe(countBefore)
  expect(await allianceRule(client)).toEqual(ruleBefore)
}

/// -------
/// Tests - Addressing a motion
/// -------

/**
 * A motion cannot be voted on or closed with the hash of its call alone.
 *
 * 1. Seed the Fellows
 * 2. Alice proposes `set_rule` with threshold 3
 * 3. Verify the motion is stored under the hash of the call and the threshold, which differs from
 *    the hash of the call alone
 * 4. Bob votes with the hash of the call alone: `ProposalMissing`
 * 5. Bob closes with the hash of the call alone: `ProposalMissing`
 * 6. Verify the motion is still open with no votes
 */
async function voteAndCloseByCallHashFail(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const allianceMotion = client.api.tx.allianceMotion
  const threshold = 3

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const length = call.method.encodedLength

  // 2. Propose
  await sendTransaction(allianceMotion.propose(threshold, call.method, length).signAsync(alice))
  await client.dev.newBlock()
  const [proposed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Proposed)
  assert(proposed, 'expected a Proposed event')
  const index = proposed.proposalIndex.toNumber()

  // 3. Stored under the hash of the call and the threshold
  const motionHash = hashOfCallAndThreshold(client, call, threshold)
  const callHash = hashOfCall(call)
  expect(callHash).not.toBe(motionHash)
  expect((await client.api.query.allianceMotion.voting(motionHash)).isSome).toBe(true)

  // 4. Vote with the hash of the call alone
  await sendTransaction(allianceMotion.vote(callHash, index, true).signAsync(bob))
  await client.dev.newBlock()
  await expectAllianceMotionError(client, 'ProposalMissing')

  // 5. Close with the hash of the call alone
  const { weight } = await call.paymentInfo(bob.address)
  await sendTransaction(allianceMotion.close(callHash, index, weight, length).signAsync(bob))
  await client.dev.newBlock()
  await expectAllianceMotionError(client, 'ProposalMissing')

  // 6. Still open, no votes
  expect(await openMotions(client)).toContain(motionHash)
  const voting = (await client.api.query.allianceMotion.voting(motionHash)).unwrap()
  expect(voting.ayes).toHaveLength(0)
  expect(voting.nays).toHaveLength(0)
}

/**
 * A motion opened, voted on and closed through the `alliance` pallet is addressed by the hash of
 * its call and threshold.
 *
 * 1. Seed the Fellows
 * 2. Alice opens a threshold 3 motion for `set_rule` through `alliance.propose`
 * 3. Verify the collective's `Proposed` event carries the hash of the call and the threshold
 * 4. All three Fellows vote aye through `alliance.vote`, addressing the motion by that hash
 * 5. Charlie closes it through `alliance.close`: it is approved and executed, and the rule is set
 * 6. Verify the motion is gone
 */
async function allianceMotionLifecycle(client: Client<any, any>) {
  const { alice, bob, charlie } = testAccounts
  const alliance = client.api.tx.alliance
  const threshold = 3

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const length = call.method.encodedLength
  const rule = call.method.args[0].toJSON()
  expect(await allianceRule(client)).not.toEqual(rule)

  // 2. Propose through the alliance pallet
  await sendTransaction(alliance.propose(threshold, call.method, length).signAsync(alice))
  await client.dev.newBlock()

  // 3. Proposed event from the collective
  await checkSystemEvents(client, { section: 'allianceMotion', method: 'Proposed' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('alliance propose with threshold 3: Proposed event')
  const [proposed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Proposed)
  assert(proposed, 'expected a Proposed event')
  const motionHash = proposed.proposalHash.toHex()
  const index = proposed.proposalIndex.toNumber()
  expect(motionHash).toBe(hashOfCallAndThreshold(client, call, threshold))
  expect(proposed.threshold.toNumber()).toBe(threshold)

  // 4. Unanimous ayes through the alliance pallet
  for (const fellow of [alice, bob, charlie]) {
    await sendTransaction(alliance.vote(motionHash, index, true).signAsync(fellow))
  }
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'allianceMotion', method: 'Voted' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('alliance vote: Voted events')
  const voted = await eventsInLastBlock(client, client.api.events.allianceMotion.Voted)
  expect(voted).toHaveLength(3)
  for (const vote of voted) {
    expect(vote.proposalHash.toHex()).toBe(motionHash)
  }
  expect(voted[2].yes.toNumber()).toBe(3)

  // 5. Close through the alliance pallet
  const { weight } = await call.paymentInfo(charlie.address)
  await sendTransaction(alliance.close(motionHash, index, weight, length).signAsync(charlie))
  await client.dev.newBlock()
  await checkSystemEvents(client, 'allianceMotion', { section: 'alliance', method: 'NewRuleSet' })
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('alliance close: collective and alliance events')
  const [closed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Closed)
  assert(closed, 'expected a Closed event')
  expect(closed.proposalHash.toHex()).toBe(motionHash)
  expect(closed.yes.toNumber()).toBe(3)
  expect(closed.no.toNumber()).toBe(0)
  const [executed] = await eventsInLastBlock(client, client.api.events.allianceMotion.Executed)
  assert(executed, 'expected an Executed event')
  expect(executed.proposalHash.toHex()).toBe(motionHash)
  expect(executed.result.isOk).toBe(true)
  expect(await allianceRule(client)).toEqual(rule)

  // 6. Motion removed
  expect(await openMotions(client)).not.toContain(motionHash)
  expect((await client.api.query.allianceMotion.proposalOf(motionHash)).isNone).toBe(true)
  expect((await client.api.query.allianceMotion.voting(motionHash)).isNone).toBe(true)
}

/// -------
/// Tests - Member execution
/// -------

/**
 * `execute` runs a call as a single member and reports the hash of the call alone.
 *
 * No threshold is involved in `execute`, so its event identifies the call by its own hash. The
 * call runs with the origin of one member, which `set_rule` rejects with `BadOrigin`; the outer
 * `execute` still succeeds and reports that result.
 *
 * 1. Seed the Fellows
 * 2. Alice executes `set_rule`
 * 3. Verify the `MemberExecuted` event: the hash of the call alone, and a `BadOrigin` result
 * 4. Verify nothing was stored and the rule did not change
 */
async function executeReportsCallHash(client: Client<any, any>) {
  const { alice } = testAccounts

  // 1. Fellows
  await seedFellows(client)
  const call = setRuleCall(client)
  const openBefore = await openMotions(client)
  const countBefore = (await client.api.query.allianceMotion.proposalCount()).toNumber()
  const ruleBefore = await allianceRule(client)

  // 2. Execute as a member
  const executeTx = client.api.tx.allianceMotion.execute(call.method, call.method.encodedLength)
  await sendTransaction(executeTx.signAsync(alice))
  await client.dev.newBlock()

  // 3. MemberExecuted event
  await checkSystemEvents(client, 'allianceMotion')
    .redact(MOTION_EVENT_REDACTION)
    .toMatchSnapshot('execute: MemberExecuted event')
  const [memberExecuted] = await eventsInLastBlock(client, client.api.events.allianceMotion.MemberExecuted)
  assert(memberExecuted, 'expected a MemberExecuted event')
  expect(memberExecuted.proposalHash.toHex()).toBe(hashOfCall(call))
  assert(memberExecuted.result.isErr, 'expected the call to fail on its origin')
  expect(memberExecuted.result.asErr.isBadOrigin).toBe(true)

  // 4. Nothing stored, rule unchanged
  expect(await openMotions(client)).toEqual(openBefore)
  expect((await client.api.query.allianceMotion.proposalCount()).toNumber()).toBe(countBefore)
  expect(await allianceRule(client)).toEqual(ruleBefore)
}

/// ----------
/// Test tree
/// ----------

/**
 * Run `body`, or skip the test on a runtime that derives a motion's hash from the call alone.
 *
 * The check comes before anything else, so a skipped test builds no block.
 */
function withThresholdInProposalHash(
  getClient: () => Client<any, any>,
  testConfig: AllianceMotionTestConfig,
  body: () => Promise<void>,
): (ctx?: TestContext) => Promise<void> {
  return async (ctx) => {
    const specVersion = getClient().api.runtimeVersion.specVersion.toNumber()
    if (specVersion < testConfig.thresholdInProposalHashSince) {
      ctx?.skip('this runtime derives a collective proposal hash from the call alone, without the threshold')
      return
    }
    await body()
  }
}

export function allianceMotionE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: AllianceMotionTestConfig): RootTestTree {
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>
  const getClient = () => client

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
        label: 'Proposal identity',
        children: [
          {
            kind: 'test',
            label: 'propose - proposal hash covers the call and the threshold',
            testFn: withThresholdInProposalHash(getClient, testConfig, () => proposeHashCoversCallAndThreshold(client)),
          },
          {
            kind: 'test',
            label: 'propose - same call with another threshold is a separate motion',
            testFn: withThresholdInProposalHash(getClient, testConfig, () => sameCallWithTwoThresholds(client)),
          },
          {
            kind: 'test',
            label: 'propose - DuplicateProposal for the same call and threshold',
            testFn: withThresholdInProposalHash(getClient, testConfig, () => proposeSameCallAndThresholdFails(client)),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Immediate execution',
        children: [
          {
            kind: 'test',
            label: 'propose with threshold 1 - Executed carries the hash of the call and the threshold',
            testFn: withThresholdInProposalHash(getClient, testConfig, () => proposeWithThresholdOneExecutes(client)),
          },
          {
            kind: 'test',
            label: 'propose with threshold 1 - runs beside a pending motion with another threshold',
            testFn: withThresholdInProposalHash(getClient, testConfig, () =>
              immediateExecutionBesidePendingMotion(client),
            ),
          },
          {
            kind: 'test',
            label: 'propose with threshold 1 - DuplicateProposal while a threshold 1 motion is pending',
            testFn: withThresholdInProposalHash(getClient, testConfig, () =>
              immediateExecutionOfPendingThresholdOneMotionFails(client),
            ),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Addressing a motion',
        children: [
          {
            kind: 'test',
            label: 'vote and close - ProposalMissing for the hash of the call alone',
            testFn: withThresholdInProposalHash(getClient, testConfig, () => voteAndCloseByCallHashFail(client)),
          },
          {
            kind: 'test',
            label: 'alliance propose, vote and close - motion addressed by its hash',
            testFn: withThresholdInProposalHash(getClient, testConfig, () => allianceMotionLifecycle(client)),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Member execution',
        children: [
          {
            kind: 'test',
            label: 'execute - MemberExecuted carries the hash of the call alone',
            testFn: () => executeReportsCallHash(client),
          },
        ],
      },
    ],
  }
}
