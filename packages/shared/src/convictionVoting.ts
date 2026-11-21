/**
 * E2E tests for the conviction voting pallet.
 *
 * Pallet model:
 * - An account votes on a poll with part of its balance, or delegates that voting power to another account. Every
 *   poll is a referendum of the referenda pallet, and its class is the referendum's track id.
 * - Votes, delegations and locks are kept per class. `VotingFor(account, class)` is either `Casting` (a sorted list of
 *   votes) or `Delegating`, never both.
 * - Voting or delegating locks the balance used. `ClassLocksFor(account)` holds one lock amount per class, and the
 *   account's balance lock (id `pyconvot`) is the largest of them. Locks only grow on their own: lowering one takes an
 *   explicit `unlock` call.
 *
 * Time units: lock periods and referendum timestamps are in the block numbers of the chain's block provider. On Asset
 * Hubs that is the relay chain, so each new block moves the clock by several relay blocks.
 *
 * Fork caveats: referendum indices depend on the forked block, so they are read from events and redacted in
 * snapshots. Exact amounts are asserted with `expect`, because snapshots round numbers.
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { KeyringPair } from '@polkadot/keyring/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import {
  blockProviderOffset,
  checkEvents,
  checkSystemEvents,
  getBlockNumber,
  scheduleInlineCallListWithSameOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import { setupBalances } from './setup.js'
import type { Client, RootTestTree } from './types.js'

/// -------
/// Constants
/// -------

/** Each test account is funded with this many existential deposits, enough for referendum deposits and fees. */
const FUNDING_ED_MULTIPLIER = 1_000_000n

/**
 * Base vote size, in existential deposits. It is far below the funded balance on purpose: the voting lock also
 * blocks fee payment, so an account that locked its whole balance could not sign another transaction.
 */
const VOTE_ED_MULTIPLIER = 1_000n

/** Track of the `SmallTipper` origin, used as the main voting class. */
const SMALL_TIPPER_CLASS = 30

/** Track of the `BigTipper` origin, used when a test needs a second class. */
const BIG_TIPPER_CLASS = 31

/** Identifier of the balance lock the pallet places on voters and delegators. */
const CONVICTION_VOTING_LOCK_ID = 'pyconvot'

/// -------
/// Helpers
/// -------

/** The base vote size in plancks: `VOTE_ED_MULTIPLIER` existential deposits. */
function voteAmount(client: Client<any, any>): bigint {
  return client.api.consts.balances.existentialDeposit.toBigInt() * VOTE_ED_MULTIPLIER
}

/** Fund every test account with `FUNDING_ED_MULTIPLIER` existential deposits, with nothing reserved or frozen. */
async function fundTestAccounts(client: Client<any, any>): Promise<void> {
  const amount = client.api.consts.balances.existentialDeposit.toBigInt() * FUNDING_ED_MULTIPLIER
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts
  await setupBalances(
    client,
    [alice, bob, charlie, dave, eve, ferdie].map((account) => ({ address: account.address, amount })),
  )
}

/**
 * Submit a referendum with the given custom origin, signed by Alice, and return its index.
 *
 * The proposal is a harmless remark. The referendum is left in its preparation period, which is already an ongoing
 * poll that accepts votes. The helper asserts that the referendum landed on the expected track.
 */
async function submitReferendum(
  client: Client<any, any>,
  origin: 'SmallTipper' | 'BigTipper',
  expectedClass: number,
): Promise<number> {
  const submitTx = client.api.tx.referenda.submit(
    { Origins: origin } as any,
    { Inline: client.api.tx.system.remark('conviction voting').method.toHex() },
    { After: 1 },
  )
  await sendTransaction(submitTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const submitted = events.filter(({ event }) => client.api.events.referenda.Submitted.is(event))
  expect(submitted, 'exactly one referendum should be submitted in the block').toHaveLength(1)
  const event = submitted[0].event
  assert(client.api.events.referenda.Submitted.is(event))
  expect(event.data.track.toNumber()).toBe(expectedClass)

  const index = event.data.index.toNumber()
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isOngoing, 'a freshly submitted referendum should be ongoing')
  return index
}

/**
 * Cancel a referendum with the `ReferendumCanceller` origin, injected through the scheduler.
 *
 * The injected call never fails as an extrinsic, so the helper asserts the scheduler's dispatch result and the
 * referendum's new state.
 */
async function cancelReferendum(client: Client<any, any>, index: number): Promise<void> {
  const blockProvider = client.config.properties.schedulerBlockProvider
  const scheduledAt = await getBlockNumber(client.api, blockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.cancel(index).method.toHex(),
    { Origins: 'ReferendumCanceller' },
    blockProvider,
  )
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const dispatched = events.filter(
    ({ event }) => client.api.events.scheduler.Dispatched.is(event) && event.data.task[0].toNumber() === scheduledAt,
  )
  expect(dispatched, 'the injected cancellation should be dispatched once').toHaveLength(1)
  const dispatchedEvent = dispatched[0].event
  assert(client.api.events.scheduler.Dispatched.is(dispatchedEvent))
  expect(dispatchedEvent.data.result.isOk, 'the injected cancellation should succeed').toBe(true)

  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome)
  expect(info.unwrap().isCancelled).toBe(true)
}

/** Read the tally of an ongoing referendum as exact integers. */
async function readTally(
  client: Client<any, any>,
  index: number,
): Promise<{ ayes: bigint; nays: bigint; support: bigint }> {
  const info = await client.api.query.referenda.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isOngoing, 'the referendum should be ongoing')
  const tally = info.unwrap().asOngoing.tally
  return { ayes: tally.ayes.toBigInt(), nays: tally.nays.toBigInt(), support: tally.support.toBigInt() }
}

/** Read an account's class locks as `[class, amount]` pairs. */
async function readClassLocks(client: Client<any, any>, address: string): Promise<[number, bigint][]> {
  const locks = await client.api.query.convictionVoting.classLocksFor(address)
  return locks.map(([cls, amount]) => [cls.toNumber(), amount.toBigInt()])
}

/**
 * Read the amount of the pallet's balance lock on an account, or `null` when there is none.
 *
 * When the lock exists, the helper also asserts that it applies to every withdrawal reason and that the account's
 * frozen balance covers it.
 */
async function readVotingLock(client: Client<any, any>, address: string): Promise<bigint | null> {
  const locks = await client.api.query.balances.locks(address)
  const lock = locks.find((l) => l.id.toUtf8() === CONVICTION_VOTING_LOCK_ID)
  if (!lock) {
    return null
  }
  expect(lock.reasons.isAll, 'the voting lock should cover every withdrawal reason').toBe(true)
  const account = await client.api.query.system.account(address)
  expect(account.data.frozen.toBigInt()).toBeGreaterThanOrEqual(lock.amount.toBigInt())
  return lock.amount.toBigInt()
}

/**
 * Everything the pallet stores for an account in one class, in JSON form.
 *
 * Failure tests capture it before and after the failing call and compare the two.
 */
async function readVotingState(client: Client<any, any>, address: string, cls: number) {
  return {
    votingFor: (await client.api.query.convictionVoting.votingFor(address, cls)).toJSON(),
    classLocks: (await client.api.query.convictionVoting.classLocksFor(address)).toJSON(),
    balanceLocks: (await client.api.query.balances.locks(address)).toJSON(),
  }
}

/**
 * Assert that the head block holds exactly one failed extrinsic, and that it failed with the named conviction
 * voting error. The name is checked against the runtime metadata first, so a renamed error fails the test instead of
 * matching nothing.
 */
async function expectConvictionVotingError(client: Client<any, any>, errorName: string): Promise<void> {
  const events = await client.api.query.system.events()
  const failures = events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failures, 'exactly one extrinsic should fail in the block').toHaveLength(1)
  const event = failures[0].event
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  const { dispatchError } = event.data
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  const errors = client.api.errors.convictionVoting as Record<string, { is: (e: any) => boolean }>
  assert(errors[errorName], `the runtime has no conviction voting error named ${errorName}`)
  expect(errors[errorName].is(dispatchError.asModule), `expected ${errorName}`).toBe(true)
}

/**
 * Find the `Voted` event of the given voter in the head block and assert its poll index and its standard vote:
 * direction, conviction (such as `Locked3x`) and balance.
 */
async function expectVotedEvent(
  client: Client<any, any>,
  voter: KeyringPair,
  pollIndex: number,
  expectedVote: { aye: boolean; conviction: string; balance: bigint },
): Promise<void> {
  const who = encodeAddress(voter.address, client.config.properties.addressEncoding)
  const events = await client.api.query.system.events()
  const voted = events.filter(
    ({ event }) => client.api.events.convictionVoting.Voted.is(event) && event.data.who.toString() === who,
  )
  expect(voted, `expected one Voted event for ${who}`).toHaveLength(1)
  const event = voted[0].event
  assert(client.api.events.convictionVoting.Voted.is(event))
  // The API's static types lack the event's third field, the poll index, so it is read from the decoded data.
  expect((event.data as any).pollIndex.toNumber()).toBe(pollIndex)
  assert(event.data.vote.isStandard)
  const standard = event.data.vote.asStandard
  expect(standard.vote.isAye).toBe(expectedVote.aye)
  expect(standard.vote.conviction.type).toBe(expectedVote.conviction)
  expect(standard.balance.toBigInt()).toBe(expectedVote.balance)
}

/**
 * Move a freshly submitted referendum into its decision period, the way the chain does it: Alice places the decision
 * deposit, then blocks are built until the preparation period is over.
 *
 * Only a deciding referendum can end as rejected, which is what the tests of finished polls need.
 */
async function startDeciding(client: Client<any, any>, index: number, cls: number): Promise<void> {
  await sendTransaction(client.api.tx.referenda.placeDecisionDeposit(index).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  const track = client.api.consts.referenda.tracks.find(([id]) => id.toNumber() === cls)
  assert(track, `track ${cls} should exist`)
  const blocksPerBlock = blockProviderOffset(
    client.config.properties.schedulerBlockProvider,
    (client.config.properties as any).relayBlocksPerParaBlock,
  )
  // The preparation period in blocks of this chain, plus a margin for the alarm that starts the decision.
  const maxBlocks = Math.ceil(track[1].preparePeriod.toNumber() / blocksPerBlock) + 3
  for (let i = 0; i < maxBlocks; i++) {
    const info = (await client.api.query.referenda.referendumInfoFor(index)).unwrap()
    if (info.asOngoing.deciding.isSome) {
      return
    }
    await client.dev.newBlock()
  }
  const info = (await client.api.query.referenda.referendumInfoFor(index)).unwrap()
  assert(info.asOngoing.deciding.isSome, 'the referendum should be deciding after its preparation period')
}

/**
 * End a deciding referendum that is not passing, and return the block number at which it was rejected.
 *
 * Waiting out a decision period is not practical, so the helper moves the start of the decision back by one decision
 * period and then lets the referenda pallet service the referendum through a Root `nudgeReferendum`. The pallet
 * itself finds the decision period over and rejects the referendum.
 */
async function rejectReferendum(client: Client<any, any>, index: number, cls: number): Promise<number> {
  const blockProvider = client.config.properties.schedulerBlockProvider
  const track = client.api.consts.referenda.tracks.find(([id]) => id.toNumber() === cls)
  assert(track, `track ${cls} should exist`)
  const ongoing = (await client.api.query.referenda.referendumInfoFor(index)).unwrap().asOngoing
  assert(ongoing.deciding.isSome, 'only a deciding referendum can be rejected')

  // The scheduled nudge runs with the block number read here, so the decision period ends exactly then.
  const now = await getBlockNumber(client.api, blockProvider)
  await client.dev.setStorage({
    Referenda: {
      ReferendumInfoFor: [
        [
          [index],
          {
            Ongoing: {
              track: ongoing.track,
              origin: ongoing.origin,
              proposal: ongoing.proposal,
              enactment: ongoing.enactment,
              submitted: ongoing.submitted,
              submissionDeposit: ongoing.submissionDeposit,
              decisionDeposit: ongoing.decisionDeposit,
              deciding: { since: now - track[1].decisionPeriod.toNumber(), confirming: null },
              tally: ongoing.tally,
              inQueue: ongoing.inQueue,
              alarm: ongoing.alarm,
            },
          },
        ],
      ],
    },
  })
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.nudgeReferendum(index).method.toHex(),
    { system: 'Root' },
    blockProvider,
  )
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const dispatched = events.filter(
    ({ event }) => client.api.events.scheduler.Dispatched.is(event) && event.data.task[0].toNumber() === now,
  )
  expect(dispatched, 'the injected nudge should be dispatched once').toHaveLength(1)
  const dispatchedEvent = dispatched[0].event
  assert(client.api.events.scheduler.Dispatched.is(dispatchedEvent))
  expect(dispatchedEvent.data.result.isOk, 'the injected nudge should succeed').toBe(true)

  const info = (await client.api.query.referenda.referendumInfoFor(index)).unwrap()
  assert(info.isRejected, `the referendum should be rejected, but it is ${info.type}`)
  return info.asRejected[0].toNumber()
}

/**
 * Rewrite the block number at which a rejected referendum ended, keeping its deposits.
 *
 * Vote locks are counted from that block, so moving it is how a test places itself just before or exactly at the end
 * of a lock that lasts days.
 */
async function setRejectionBlock(client: Client<any, any>, index: number, end: number): Promise<void> {
  const rejected = (await client.api.query.referenda.referendumInfoFor(index)).unwrap().asRejected
  await client.dev.setStorage({
    Referenda: { ReferendumInfoFor: [[[index], { Rejected: [end, rejected[1], rejected[2]] }]] },
  })
  const info = (await client.api.query.referenda.referendumInfoFor(index)).unwrap()
  expect(info.asRejected[0].toNumber()).toBe(end)
}

/**
 * Assert that every extrinsic of the head block succeeded and that none of them emitted a conviction voting event.
 *
 * Removing a vote from a finished poll is silent, so success has to be read from the absence of a failure.
 */
async function expectSuccessWithoutVotingEvents(client: Client<any, any>): Promise<void> {
  const events = await client.api.query.system.events()
  expect(events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))).toHaveLength(0)
  expect(events.filter(({ event }) => event.section === 'convictionVoting')).toHaveLength(0)
}

/** Find the `VoteRemoved` event of the given voter in the head block and assert its vote and poll index. */
async function expectVoteRemovedEvent(
  client: Client<any, any>,
  voter: KeyringPair,
  pollIndex: number,
  expectedVote: { aye: boolean; conviction: string; balance: bigint },
): Promise<void> {
  const who = encodeAddress(voter.address, client.config.properties.addressEncoding)
  const events = await client.api.query.system.events()
  const removed = events.filter(
    ({ event }) => client.api.events.convictionVoting.VoteRemoved.is(event) && event.data.who.toString() === who,
  )
  expect(removed, `expected one VoteRemoved event for ${who}`).toHaveLength(1)
  const event = removed[0].event
  assert(client.api.events.convictionVoting.VoteRemoved.is(event))
  // The API's static types lack the event's third field, the poll index, so it is read from the decoded data.
  expect((event.data as any).pollIndex.toNumber()).toBe(pollIndex)
  assert(event.data.vote.isStandard)
  const standard = event.data.vote.asStandard
  expect(standard.vote.isAye).toBe(expectedVote.aye)
  expect(standard.vote.conviction.type).toBe(expectedVote.conviction)
  expect(standard.balance.toBigInt()).toBe(expectedVote.balance)
}

/** Build a standard vote argument for `convictionVoting.vote`. */
function standardVote(aye: boolean, conviction: string, balance: bigint) {
  return { Standard: { vote: { aye, conviction }, balance } }
}

/// -------
/// Voting
/// -------

/**
 * A standard vote is weighted by its conviction in the tally, and locks the voted balance.
 *
 * This is the base case every other test builds on. It checks the tally of a real referendum, where an aye counts
 * its capital as support and a vote without conviction counts for a tenth of its balance.
 *
 * 1. Submit a referendum on the main class
 * 2. Charlie votes aye with 3x conviction, Dave votes nay with no conviction
 * 3. Verify both `Voted` events
 * 4. Verify the referendum's tally
 * 5. Verify each voter's recorded vote, class lock and balance lock
 */
async function voteWeightsTallyAndLocksTest(client: Client<any, any>) {
  const { charlie, dave } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  expect(await readTally(client, poll)).toEqual({ ayes: 0n, nays: 0n, support: 0n })

  // 2. Charlie votes aye with 3x conviction, Dave votes nay with no conviction
  const charlieEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked3x', vote)).signAsync(charlie),
  )
  const daveEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(false, 'None', vote)).signAsync(dave),
  )
  await client.dev.newBlock()

  // 3. Both votes emitted `Voted`
  await checkEvents(charlieEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('aye vote with 3x conviction')
  await checkEvents(daveEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('nay vote with no conviction')
  await expectVotedEvent(client, charlie, poll, { aye: true, conviction: 'Locked3x', balance: vote })
  await expectVotedEvent(client, dave, poll, { aye: false, conviction: 'None', balance: vote })

  // 4. The aye counts three times and adds its capital to support; the nay counts for a tenth
  expect(await readTally(client, poll)).toEqual({ ayes: 3n * vote, nays: vote / 10n, support: vote })

  // 5. Each voter has one recorded vote, a class lock and a balance lock of the voted amount
  for (const voter of [charlie, dave]) {
    const voting = await client.api.query.convictionVoting.votingFor(voter.address, SMALL_TIPPER_CLASS)
    assert(voting.isCasting)
    expect(voting.asCasting.votes).toHaveLength(1)
    expect(voting.asCasting.votes[0][0].toNumber()).toBe(poll)
    expect(voting.asCasting.votes[0][1].asStandard.balance.toBigInt()).toBe(vote)
    expect(await readClassLocks(client, voter.address)).toEqual([[SMALL_TIPPER_CLASS, vote]])
    expect(await readVotingLock(client, voter.address)).toBe(vote)
  }
}

/**
 * Voting again on the same poll replaces the earlier vote, but the lock keeps its larger amount until `unlock`.
 *
 * Locks are only ever extended by a vote, because the pallet cannot tell cheaply which other votes need them. A
 * voter who lowers their vote gets the difference back only by calling `unlock`.
 *
 * 1. Submit a referendum and vote aye with twice the base amount
 * 2. Vote again on the same poll: nay, no conviction, the base amount
 * 3. Verify one vote is recorded and the tally holds only the second vote
 * 4. Verify the lock still covers the first, larger vote
 * 5. Call `unlock` and verify the lock drops to the second vote's amount
 */
async function voteAgainReplacesVoteTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum and vote aye with twice the base amount
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked1x', 2n * vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, charlie, poll, { aye: true, conviction: 'Locked1x', balance: 2n * vote })
  expect(await readTally(client, poll)).toEqual({ ayes: 2n * vote, nays: 0n, support: 2n * vote })

  // 2. Vote again: nay, no conviction, the base amount
  const revoteEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(false, 'None', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(revoteEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('second vote on the same poll')
  await expectVotedEvent(client, charlie, poll, { aye: false, conviction: 'None', balance: vote })

  // 3. One vote recorded, and the first vote is gone from the tally
  const voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes).toHaveLength(1)
  expect(voting.asCasting.votes[0][1].asStandard.vote.isAye).toBe(false)
  expect(voting.asCasting.votes[0][1].asStandard.balance.toBigInt()).toBe(vote)
  expect(await readTally(client, poll)).toEqual({ ayes: 0n, nays: vote / 10n, support: 0n })

  // 4. The lock still covers the first vote
  expect(await readClassLocks(client, charlie.address)).toEqual([[SMALL_TIPPER_CLASS, 2n * vote]])
  expect(await readVotingLock(client, charlie.address)).toBe(2n * vote)

  // 5. `unlock` lowers the lock to what the remaining vote needs
  const unlockEvents = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(unlockEvents, 'convictionVoting').toMatchSnapshot('unlock after lowering the vote')
  const events = await client.api.query.system.events()
  const unlocked = events.filter(({ event }) => client.api.events.convictionVoting.VoteUnlocked.is(event))
  expect(unlocked).toHaveLength(1)
  const unlockedEvent = unlocked[0].event
  assert(client.api.events.convictionVoting.VoteUnlocked.is(unlockedEvent))
  expect(unlockedEvent.data.who.toString()).toBe(
    encodeAddress(charlie.address, client.config.properties.addressEncoding),
  )
  expect(unlockedEvent.data.class.toNumber()).toBe(SMALL_TIPPER_CLASS)
  expect(await readClassLocks(client, charlie.address)).toEqual([[SMALL_TIPPER_CLASS, vote]])
  expect(await readVotingLock(client, charlie.address)).toBe(vote)
}

/**
 * Votes on two polls of one class share a lock: it is the largest vote, not the sum.
 *
 * The same balance can back any number of concurrent votes, which is what lets a voter take part in every referendum
 * with their full balance.
 *
 * 1. Submit two referenda on the main class
 * 2. Vote on the second with twice the base amount, then on the first with the base amount
 * 3. Verify both votes are recorded, ordered by poll index
 * 4. Verify the class lock and balance lock equal the larger vote
 */
async function voteOnTwoPollsLocksLargestTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit two referenda
  const firstPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const secondPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  expect(secondPoll).toBeGreaterThan(firstPoll)

  // 2. Vote on the second poll first, so that the list has to be kept sorted on the next insert
  const secondEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(secondPoll, standardVote(true, 'Locked1x', 2n * vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(secondEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('vote on the second poll')
  await expectVotedEvent(client, charlie, secondPoll, { aye: true, conviction: 'Locked1x', balance: 2n * vote })

  const firstEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(firstPoll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(firstEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('vote on the first poll')
  await expectVotedEvent(client, charlie, firstPoll, { aye: true, conviction: 'Locked1x', balance: vote })

  // 3. Both votes recorded, ordered by poll index
  const voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes.map(([index]) => index.toNumber())).toEqual([firstPoll, secondPoll])

  // 4. One lock for the class, sized by the larger vote
  expect(await readClassLocks(client, charlie.address)).toEqual([[SMALL_TIPPER_CLASS, 2n * vote]])
  expect(await readVotingLock(client, charlie.address)).toBe(2n * vote)
}

/**
 * A vote larger than the voter's total balance is rejected.
 *
 * The limit is the total balance, reserved funds included. Alice is the voter because her submission deposit is
 * reserved, which makes her total differ from her free balance.
 *
 * 1. Submit a referendum, which reserves Alice's submission deposit
 * 2. Alice votes with one planck more than her total balance
 * 3. Verify the call failed with `InsufficientFunds`
 * 4. Verify nothing was recorded or locked, and the tally is unchanged
 */
async function voteAboveTotalBalanceFailsTest(client: Client<any, any>) {
  const { alice } = testAccounts
  await fundTestAccounts(client)

  // 1. Submit a referendum
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const account = await client.api.query.system.account(alice.address)
  expect(account.data.reserved.toBigInt()).toBe(client.api.consts.referenda.submissionDeposit.toBigInt())
  const total = account.data.free.toBigInt() + account.data.reserved.toBigInt()
  const stateBefore = await readVotingState(client, alice.address, SMALL_TIPPER_CLASS)

  // 2. Vote with one planck more than the total balance
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'None', total + 1n)).signAsync(alice),
  )
  await client.dev.newBlock()

  // 3. InsufficientFunds
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'vote above the total balance',
  )
  await expectConvictionVotingError(client, 'InsufficientFunds')

  // 4. Nothing recorded or locked
  expect(await readVotingState(client, alice.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, alice.address)).toBeNull()
  expect(await readTally(client, poll)).toEqual({ ayes: 0n, nays: 0n, support: 0n })
}

/**
 * A vote on a cancelled referendum is rejected, because the poll is no longer ongoing.
 *
 * 1. Submit a referendum
 * 2. Cancel it with the `ReferendumCanceller` origin
 * 3. Charlie votes on it
 * 4. Verify the call failed with `NotOngoing`
 * 5. Verify nothing was recorded or locked
 */
async function voteOnCancelledPollFailsTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)

  // 2. Cancel it
  await cancelReferendum(client, poll)
  const stateBefore = await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)

  // 3. Vote on the cancelled poll. The balance is affordable, so only the poll's state can reject the vote.
  const account = await client.api.query.system.account(charlie.address)
  expect(account.data.free.toBigInt()).toBeGreaterThan(vote)
  await sendTransaction(client.api.tx.convictionVoting.vote(poll, standardVote(true, 'None', vote)).signAsync(charlie))
  await client.dev.newBlock()

  // 4. NotOngoing
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'vote on a cancelled poll',
  )
  await expectConvictionVotingError(client, 'NotOngoing')

  // 5. Nothing recorded or locked
  expect(await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, charlie.address)).toBeNull()
}

/**
 * An account that delegates a class cannot vote in that class, but stays free to vote in every other class.
 *
 * Delegation is per class, so the restriction is too.
 *
 * 1. Bob delegates the main class to Charlie
 * 2. Submit one referendum on the main class and one on a second class
 * 3. Bob votes on the main-class referendum
 * 4. Verify the call failed with `AlreadyDelegating`, and Bob's delegation and the tally are unchanged
 * 5. Bob votes on the second-class referendum
 * 6. Verify the vote is recorded
 */
async function voteWhileDelegatingFailsTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Bob delegates the main class to Charlie
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'Locked1x', vote).signAsync(bob),
  )
  await client.dev.newBlock()
  const delegating = await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)
  assert(delegating.isDelegating, 'Bob should be delegating the main class')

  // 2. One referendum per class
  const mainPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const secondPoll = await submitReferendum(client, 'BigTipper', BIG_TIPPER_CLASS)
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)

  // 3. Bob votes in the class he delegated
  await sendTransaction(client.api.tx.convictionVoting.vote(mainPoll, standardVote(true, 'None', vote)).signAsync(bob))
  await client.dev.newBlock()

  // 4. AlreadyDelegating, with nothing changed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'vote in a delegated class',
  )
  await expectConvictionVotingError(client, 'AlreadyDelegating')
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readTally(client, mainPoll)).toEqual({ ayes: 0n, nays: 0n, support: 0n })

  // 5. Bob votes in a class he did not delegate
  const voteEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(secondPoll, standardVote(true, 'Locked1x', vote)).signAsync(bob),
  )
  await client.dev.newBlock()

  // 6. The vote is recorded
  await checkEvents(voteEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('vote in a class that is not delegated')
  await expectVotedEvent(client, bob, secondPoll, { aye: true, conviction: 'Locked1x', balance: vote })
  const voting = await client.api.query.convictionVoting.votingFor(bob.address, BIG_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes.map(([index]) => index.toNumber())).toEqual([secondPoll])
  expect(await readTally(client, secondPoll)).toEqual({ ayes: vote, nays: 0n, support: vote })
}

/**
 * An account can hold `MaxVotes` votes in a class. The next vote on a new poll is rejected, while changing an
 * existing vote is still allowed.
 *
 * Reaching the limit with real votes would take hundreds of referenda. Instead the test writes one vote short of the
 * limit into storage, on the oldest referendum indices, together with the class lock and balance lock those votes
 * imply. The votes that cross the limit are real.
 *
 * 1. Write `MaxVotes - 1` votes for Charlie into storage, and read them back
 * 2. Submit two referenda
 * 3. Charlie votes on the first: the vote is accepted and fills the list
 * 4. Charlie votes on the second
 * 5. Verify the call failed with `MaxVotesReached`, and neither the list nor the second tally changed
 * 6. Charlie changes his vote on the first referendum, and the change is accepted
 */
async function voteUpToMaxVotesTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  const maxVotes = client.api.consts.convictionVoting.maxVotes.toNumber()
  await fundTestAccounts(client)

  // 1. Write `MaxVotes - 1` votes with no conviction on the oldest referendum indices, sorted by index
  const injectedVotes = Array.from({ length: maxVotes - 1 }, (_, index) => [index, standardVote(true, 'None', vote)])
  const account = await client.api.query.system.account(charlie.address)
  await client.dev.setStorage({
    ConvictionVoting: {
      VotingFor: [
        [
          [charlie.address, SMALL_TIPPER_CLASS],
          { Casting: { votes: injectedVotes, delegations: { votes: 0, capital: 0 }, prior: [0, 0] } },
        ],
      ],
      ClassLocksFor: [[[charlie.address], [[SMALL_TIPPER_CLASS, vote]]]],
    },
    Balances: {
      Locks: [[[charlie.address], [{ id: CONVICTION_VOTING_LOCK_ID, amount: vote, reasons: 'All' }]]],
    },
    System: {
      account: [
        [
          [charlie.address],
          {
            nonce: account.nonce.toNumber(),
            consumers: account.consumers.toNumber(),
            providers: account.providers.toNumber(),
            sufficients: account.sufficients.toNumber(),
            data: { free: account.data.free.toBigInt(), reserved: 0, frozen: vote },
          },
        ],
      ],
    },
  })
  let voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes).toHaveLength(maxVotes - 1)
  expect(await readVotingLock(client, charlie.address)).toBe(vote)

  // 2. Submit two referenda. Their indices are above every injected one, so they are new entries in the list.
  const firstPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const secondPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  expect(firstPoll).toBeGreaterThanOrEqual(maxVotes - 1)

  // 3. The vote that fills the list is accepted
  const fillingEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(firstPoll, standardVote(true, 'None', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(fillingEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('vote that fills the list')
  await expectVotedEvent(client, charlie, firstPoll, { aye: true, conviction: 'None', balance: vote })
  voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  expect(voting.asCasting.votes).toHaveLength(maxVotes)

  // 4. One vote too many
  await sendTransaction(
    client.api.tx.convictionVoting.vote(secondPoll, standardVote(true, 'None', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()

  // 5. MaxVotesReached, with nothing changed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'vote beyond the limit',
  )
  await expectConvictionVotingError(client, 'MaxVotesReached')
  voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  expect(voting.asCasting.votes).toHaveLength(maxVotes)
  expect(await readTally(client, secondPoll)).toEqual({ ayes: 0n, nays: 0n, support: 0n })

  // 6. Changing an existing vote does not add an entry, so it is still allowed
  const changeEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(firstPoll, standardVote(false, 'None', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(changeEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('changed vote with a full list')
  await expectVotedEvent(client, charlie, firstPoll, { aye: false, conviction: 'None', balance: vote })
  voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  expect(voting.asCasting.votes).toHaveLength(maxVotes)
  expect(await readTally(client, firstPoll)).toEqual({ ayes: 0n, nays: vote / 10n, support: 0n })
}

/// -------
/// Delegation
/// -------

/**
 * Delegating adds the delegated voting power to the target's existing vote, and locks the delegated balance.
 *
 * The target votes before the delegation is made, so the delegation has to be pushed into a tally that already
 * holds the target's vote.
 *
 * 1. Submit a referendum; Charlie votes aye with 1x conviction
 * 2. Bob delegates twice the base amount to Charlie with 2x conviction
 * 3. Verify the `Delegated` event
 * 4. Verify Bob's delegation record and lock
 * 5. Verify Charlie's received delegations and the referendum's tally
 */
async function delegateAddsToTargetVoteTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  const addressEncoding = client.config.properties.addressEncoding
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie votes aye with 1x conviction
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  expect(await readTally(client, poll)).toEqual({ ayes: vote, nays: 0n, support: vote })

  // 2. Bob delegates twice the base amount to Charlie with 2x conviction
  const delegateEvents = await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'Locked2x', 2n * vote).signAsync(bob),
  )
  await client.dev.newBlock()

  // 3. `Delegated` names the delegator, the target and the class
  await checkEvents(delegateEvents, 'convictionVoting').toMatchSnapshot('delegation with 2x conviction')
  const events = await client.api.query.system.events()
  const delegated = events.filter(({ event }) => client.api.events.convictionVoting.Delegated.is(event))
  expect(delegated).toHaveLength(1)
  const delegatedEvent = delegated[0].event
  assert(client.api.events.convictionVoting.Delegated.is(delegatedEvent))
  expect(delegatedEvent.data[0].toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(delegatedEvent.data[1].toString()).toBe(encodeAddress(charlie.address, addressEncoding))
  // The API's static types lack the event's class field, so it is read from the decoded data.
  expect((delegatedEvent.data as any)[2].toNumber()).toBe(SMALL_TIPPER_CLASS)

  // 4. Bob's record holds the delegation, and his balance is locked
  const bobVoting = await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)
  assert(bobVoting.isDelegating)
  const delegating = bobVoting.asDelegating
  expect(delegating.balance.toBigInt()).toBe(2n * vote)
  expect(delegating.target.toString()).toBe(encodeAddress(charlie.address, addressEncoding))
  expect(delegating.conviction.type).toBe('Locked2x')
  expect(delegating.delegations.votes.toBigInt()).toBe(0n)
  expect(delegating.prior[1].toBigInt()).toBe(0n)
  expect(await readClassLocks(client, bob.address)).toEqual([[SMALL_TIPPER_CLASS, 2n * vote]])
  expect(await readVotingLock(client, bob.address)).toBe(2n * vote)

  // 5. Charlie received twice Bob's balance in votes, and they count towards his aye
  const charlieVoting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(charlieVoting.isCasting)
  expect(charlieVoting.asCasting.delegations.votes.toBigInt()).toBe(4n * vote)
  expect(charlieVoting.asCasting.delegations.capital.toBigInt()).toBe(2n * vote)
  expect(await readTally(client, poll)).toEqual({ ayes: 5n * vote, nays: 0n, support: 3n * vote })
}

/**
 * Undelegating takes the delegated power back out of the target's vote, and keeps the balance locked for the
 * conviction's lock time.
 *
 * The lock time starts when the delegation ends: two lock periods for 2x conviction.
 *
 * 1. Submit a referendum; Charlie votes aye; Bob delegates to Charlie with 2x conviction
 * 2. Bob undelegates
 * 3. Verify the `Undelegated` event
 * 4. Verify the tally and Charlie's delegations are back to their values before the delegation
 * 5. Verify Bob holds a prior lock that ends two lock periods after the undelegation
 * 6. Bob calls `unlock`, and the lock stays in place
 */
async function undelegateKeepsConvictionLockTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  const addressEncoding = client.config.properties.addressEncoding
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie votes aye; Bob delegates to Charlie with 2x conviction
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'Locked2x', 2n * vote).signAsync(bob),
  )
  await client.dev.newBlock()
  expect(await readTally(client, poll)).toEqual({ ayes: 5n * vote, nays: 0n, support: 3n * vote })

  // 2. Bob undelegates
  const undelegateEvents = await sendTransaction(
    client.api.tx.convictionVoting.undelegate(SMALL_TIPPER_CLASS).signAsync(bob),
  )
  await client.dev.newBlock()
  // The extrinsic ran with this block's block-provider number.
  const undelegatedAt = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)

  // 3. `Undelegated` names the delegator and the class
  await checkEvents(undelegateEvents, 'convictionVoting').toMatchSnapshot('undelegation')
  const events = await client.api.query.system.events()
  const undelegated = events.filter(({ event }) => client.api.events.convictionVoting.Undelegated.is(event))
  expect(undelegated).toHaveLength(1)
  const undelegatedEvent = undelegated[0].event
  assert(client.api.events.convictionVoting.Undelegated.is(undelegatedEvent))
  expect(undelegatedEvent.data[0].toString()).toBe(encodeAddress(bob.address, addressEncoding))
  // The API's static types lack the event's class field, so it is read from the decoded data.
  expect((undelegatedEvent.data as any)[1].toNumber()).toBe(SMALL_TIPPER_CLASS)

  // 4. Only Charlie's own vote is left in the tally
  expect(await readTally(client, poll)).toEqual({ ayes: vote, nays: 0n, support: vote })
  const charlieVoting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  expect(charlieVoting.asCasting.delegations.votes.toBigInt()).toBe(0n)
  expect(charlieVoting.asCasting.delegations.capital.toBigInt()).toBe(0n)

  // 5. Bob is back to casting with no votes, and a prior lock of two lock periods on the delegated balance
  const lockPeriod = client.api.consts.convictionVoting.voteLockingPeriod.toNumber()
  let bobVoting = await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)
  assert(bobVoting.isCasting)
  expect(bobVoting.asCasting.votes).toHaveLength(0)
  expect(bobVoting.asCasting.prior[0].toNumber()).toBe(undelegatedAt + 2 * lockPeriod)
  expect(bobVoting.asCasting.prior[1].toBigInt()).toBe(2n * vote)

  // 6. `unlock` cannot release a prior lock that has not ended
  const unlockEvents = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, bob.address).signAsync(bob),
  )
  await client.dev.newBlock()
  await checkEvents(unlockEvents, 'convictionVoting').toMatchSnapshot('unlock during the conviction lock')
  bobVoting = await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)
  expect(bobVoting.asCasting.prior[1].toBigInt()).toBe(2n * vote)
  expect(await readClassLocks(client, bob.address)).toEqual([[SMALL_TIPPER_CLASS, 2n * vote]])
  expect(await readVotingLock(client, bob.address)).toBe(2n * vote)
}

/**
 * A delegation without conviction has no lock time: once it is undone, `unlock` frees the balance at once.
 *
 * 1. Bob delegates to Charlie with no conviction
 * 2. Bob undelegates
 * 3. Verify the prior lock ends at the block of the undelegation
 * 4. Bob calls `unlock`
 * 5. Verify no class lock, no balance lock and no frozen balance are left
 */
async function undelegateWithoutConvictionUnlocksTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Bob delegates to Charlie with no conviction
  const delegateEvents = await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'None', vote).signAsync(bob),
  )
  await client.dev.newBlock()
  await checkEvents(delegateEvents, 'convictionVoting').toMatchSnapshot('delegation with no conviction')
  expect(await readVotingLock(client, bob.address)).toBe(vote)

  // 2. Bob undelegates
  const undelegateEvents = await sendTransaction(
    client.api.tx.convictionVoting.undelegate(SMALL_TIPPER_CLASS).signAsync(bob),
  )
  await client.dev.newBlock()
  const undelegatedAt = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
  await checkEvents(undelegateEvents, 'convictionVoting').toMatchSnapshot('undelegation with no conviction')

  // 3. The prior lock ends where it starts, and the balance is still locked until `unlock` is called
  const bobVoting = await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)
  assert(bobVoting.isCasting)
  expect(bobVoting.asCasting.prior[0].toNumber()).toBe(undelegatedAt)
  expect(bobVoting.asCasting.prior[1].toBigInt()).toBe(vote)
  expect(await readVotingLock(client, bob.address)).toBe(vote)

  // 4. Bob calls `unlock`
  const unlockEvents = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, bob.address).signAsync(bob),
  )
  await client.dev.newBlock()
  await checkEvents(unlockEvents, 'convictionVoting').toMatchSnapshot('unlock after undelegation')

  // 5. Nothing is left locked
  expect(await readClassLocks(client, bob.address)).toEqual([])
  expect(await readVotingLock(client, bob.address)).toBeNull()
  const account = await client.api.query.system.account(bob.address)
  expect(account.data.frozen.toBigInt()).toBe(0n)
}

/**
 * An account cannot delegate to itself.
 *
 * 1. Bob delegates to himself
 * 2. Verify the call failed with `Nonsense`
 * 3. Verify nothing was recorded or locked
 */
async function delegateToSelfFailsTest(client: Client<any, any>) {
  const { bob } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)

  // 1. Bob delegates to himself
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, bob.address, 'Locked1x', vote).signAsync(bob),
  )
  await client.dev.newBlock()

  // 2. Nonsense
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'delegation to self',
  )
  await expectConvictionVotingError(client, 'Nonsense')

  // 3. Nothing recorded or locked
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, bob.address)).toBeNull()
}

/**
 * A delegation must name a class that is a referenda track.
 *
 * 1. Verify the class used is not a track on this chain
 * 2. Bob delegates that class to Charlie
 * 3. Verify the call failed with `BadClass`
 * 4. Verify nothing was recorded or locked
 */
async function delegateUnknownClassFailsTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  const unknownClass = 99
  await fundTestAccounts(client)

  // 1. The class is not a track
  const trackIds = client.api.consts.referenda.tracks.map(([id]) => id.toNumber())
  expect(trackIds).not.toContain(unknownClass)
  const stateBefore = await readVotingState(client, bob.address, unknownClass)

  // 2. Bob delegates the unknown class
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(unknownClass, charlie.address, 'Locked1x', vote).signAsync(bob),
  )
  await client.dev.newBlock()

  // 3. BadClass
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'delegation of an unknown class',
  )
  await expectConvictionVotingError(client, 'BadClass')

  // 4. Nothing recorded or locked
  expect(await readVotingState(client, bob.address, unknownClass)).toEqual(stateBefore)
  expect(await readVotingLock(client, bob.address)).toBeNull()
}

/**
 * A delegation larger than the delegator's total balance is rejected.
 *
 * 1. Bob delegates one planck more than his total balance
 * 2. Verify the call failed with `InsufficientFunds`
 * 3. Verify nothing was recorded or locked
 */
async function delegateAboveTotalBalanceFailsTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  await fundTestAccounts(client)
  const account = await client.api.query.system.account(bob.address)
  const total = account.data.free.toBigInt() + account.data.reserved.toBigInt()
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)

  // 1. Bob delegates one planck more than his total balance
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'None', total + 1n).signAsync(bob),
  )
  await client.dev.newBlock()

  // 2. InsufficientFunds
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'delegation above the total balance',
  )
  await expectConvictionVotingError(client, 'InsufficientFunds')

  // 3. Nothing recorded or locked
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, bob.address)).toBeNull()
}

/**
 * A class can be delegated to one account at a time. Changing the target takes an `undelegate` first.
 *
 * 1. Bob delegates the main class to Charlie
 * 2. Bob delegates the same class to Dave
 * 3. Verify the call failed with `AlreadyDelegating`
 * 4. Verify Bob still delegates to Charlie, and Dave received nothing
 */
async function delegateTwiceFailsTest(client: Client<any, any>) {
  const { bob, charlie, dave } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Bob delegates the main class to Charlie
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'Locked1x', vote).signAsync(bob),
  )
  await client.dev.newBlock()
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)
  expect((await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)).isDelegating).toBe(true)

  // 2. Bob delegates the same class to Dave
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, dave.address, 'Locked1x', vote).signAsync(bob),
  )
  await client.dev.newBlock()

  // 3. AlreadyDelegating
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'second delegation of the same class',
  )
  await expectConvictionVotingError(client, 'AlreadyDelegating')

  // 4. The first delegation stands
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  const daveVoting = await client.api.query.convictionVoting.votingFor(dave.address, SMALL_TIPPER_CLASS)
  assert(daveVoting.isCasting)
  expect(daveVoting.asCasting.delegations.votes.toBigInt()).toBe(0n)
}

/**
 * An account with a vote in a class cannot delegate that class until the vote is removed.
 *
 * 1. Submit a referendum; Bob votes on it
 * 2. Bob delegates the same class to Charlie
 * 3. Verify the call failed with `AlreadyVoting`
 * 4. Verify Bob's vote stands, and Charlie received nothing
 */
async function delegateWhileVotingFailsTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum; Bob votes on it
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked1x', vote)).signAsync(bob))
  await client.dev.newBlock()
  await expectVotedEvent(client, bob, poll, { aye: true, conviction: 'Locked1x', balance: vote })
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)

  // 2. Bob delegates the class he voted in
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'Locked1x', vote).signAsync(bob),
  )
  await client.dev.newBlock()

  // 3. AlreadyVoting
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'delegation of a class with a vote',
  )
  await expectConvictionVotingError(client, 'AlreadyVoting')

  // 4. The vote stands
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  const charlieVoting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(charlieVoting.isCasting)
  expect(charlieVoting.asCasting.delegations.votes.toBigInt()).toBe(0n)
  expect(await readTally(client, poll)).toEqual({ ayes: vote, nays: 0n, support: vote })
}

/**
 * Undelegating a class that is not delegated is rejected.
 *
 * 1. Bob, who has never delegated, undelegates the main class
 * 2. Verify the call failed with `NotDelegating`
 * 3. Verify nothing was recorded or locked
 */
async function undelegateWithoutDelegationFailsTest(client: Client<any, any>) {
  const { bob } = testAccounts
  await fundTestAccounts(client)
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)

  // 1. Bob undelegates a class he never delegated
  await sendTransaction(client.api.tx.convictionVoting.undelegate(SMALL_TIPPER_CLASS).signAsync(bob))
  await client.dev.newBlock()

  // 2. NotDelegating
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'undelegation without a delegation',
  )
  await expectConvictionVotingError(client, 'NotDelegating')

  // 3. Nothing recorded or locked
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, bob.address)).toBeNull()
}

/**
 * Delegated voting power follows only standard votes. If the target casts a split vote, the delegation is recorded
 * but adds nothing to the tally.
 *
 * A split vote has no single direction, so there is no side the delegated votes could be added to.
 *
 * 1. Submit a referendum; Charlie casts a split vote
 * 2. Bob delegates to Charlie
 * 3. Verify Charlie's received delegations grew
 * 4. Verify the tally is unchanged by the delegation
 */
async function delegateToSplitVoterTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie casts a split vote
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const splitEvents = await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, { Split: { aye: vote, nay: vote } }).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(splitEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('split vote')
  // Each side of a split vote counts for a tenth, and only the aye side counts as support.
  const tallyBefore = await readTally(client, poll)
  expect(tallyBefore).toEqual({ ayes: vote / 10n, nays: vote / 10n, support: vote })

  // 2. Bob delegates to Charlie
  const delegateEvents = await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'Locked1x', 2n * vote).signAsync(bob),
  )
  await client.dev.newBlock()
  await checkEvents(delegateEvents, 'convictionVoting').toMatchSnapshot('delegation to a split voter')
  expect((await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)).isDelegating).toBe(true)

  // 3. Charlie's record holds the delegation
  const charlieVoting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(charlieVoting.isCasting)
  expect(charlieVoting.asCasting.delegations.votes.toBigInt()).toBe(2n * vote)
  expect(charlieVoting.asCasting.delegations.capital.toBigInt()).toBe(2n * vote)

  // 4. The tally did not move
  expect(await readTally(client, poll)).toEqual(tallyBefore)
}

/// -------
/// Removing votes
/// -------

/**
 * A vote removed while its poll is ongoing leaves the tally and carries no lock time, whatever its conviction.
 *
 * The call is made without a class, which the pallet then takes from the ongoing poll.
 *
 * 1. Submit a referendum; Charlie votes aye with 2x conviction
 * 2. Charlie removes the vote, without naming the class
 * 3. Verify the `VoteRemoved` event
 * 4. Verify the tally is empty, the vote is gone and no prior lock was kept
 * 5. Verify the balance stays locked until Charlie calls `unlock`
 */
async function removeVoteDuringPollTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie votes aye with 2x conviction
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked2x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  expect(await readTally(client, poll)).toEqual({ ayes: 2n * vote, nays: 0n, support: vote })

  // 2. Charlie removes the vote, without naming the class
  const removeEvents = await sendTransaction(client.api.tx.convictionVoting.removeVote(null, poll).signAsync(charlie))
  await client.dev.newBlock()

  // 3. `VoteRemoved` carries the removed vote
  await checkEvents(removeEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('vote removed during the poll')
  await expectVoteRemovedEvent(client, charlie, poll, { aye: true, conviction: 'Locked2x', balance: vote })

  // 4. The tally is empty, the vote is gone, and no prior lock was kept
  expect(await readTally(client, poll)).toEqual({ ayes: 0n, nays: 0n, support: 0n })
  const voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes).toHaveLength(0)
  expect(voting.asCasting.prior[1].toBigInt()).toBe(0n)

  // 5. The balance lock outlives the vote until `unlock` is called
  expect(await readVotingLock(client, charlie.address)).toBe(vote)
  const unlockEvents = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(unlockEvents, 'convictionVoting').toMatchSnapshot('unlock after removing the vote')
  expect(await readClassLocks(client, charlie.address)).toEqual([])
  expect(await readVotingLock(client, charlie.address)).toBeNull()
}

/**
 * After a referendum is cancelled, a vote on it can only be removed by naming its class, and the removal is silent.
 *
 * A cancelled referendum no longer records its track, so the pallet cannot work the class out. With the class given,
 * the vote is dropped with no event and no lock time, since a cancelled poll has no outcome.
 *
 * 1. Submit a referendum; Charlie votes aye with 3x conviction
 * 2. Cancel the referendum
 * 3. Charlie removes the vote without naming the class
 * 4. Verify the call failed with `ClassNeeded`, and the vote is still recorded
 * 5. Charlie removes the vote, naming the class
 * 6. Verify the call succeeded with no conviction voting event, and the vote is gone with no prior lock
 * 7. Charlie calls `unlock`, and the balance lock is removed
 */
async function removeVoteAfterCancellationTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie votes aye with 3x conviction
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked3x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, charlie, poll, { aye: true, conviction: 'Locked3x', balance: vote })

  // 2. Cancel the referendum
  await cancelReferendum(client, poll)
  const stateBefore = await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)

  // 3. Charlie removes the vote without naming the class
  await sendTransaction(client.api.tx.convictionVoting.removeVote(null, poll).signAsync(charlie))
  await client.dev.newBlock()

  // 4. ClassNeeded, and the vote is still recorded
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'vote removal without a class after cancellation',
  )
  await expectConvictionVotingError(client, 'ClassNeeded')
  expect(await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)

  // 5. Charlie removes the vote, naming the class
  await sendTransaction(client.api.tx.convictionVoting.removeVote(SMALL_TIPPER_CLASS, poll).signAsync(charlie))
  await client.dev.newBlock()

  // 6. The removal succeeded silently, with no lock time despite the conviction
  await expectSuccessWithoutVotingEvents(client)
  const voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes).toHaveLength(0)
  expect(voting.asCasting.prior[1].toBigInt()).toBe(0n)

  // 7. `unlock` removes the balance lock
  const unlockEvents = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(unlockEvents, 'convictionVoting').toMatchSnapshot('unlock after cancellation')
  expect(await readClassLocks(client, charlie.address)).toEqual([])
  expect(await readVotingLock(client, charlie.address)).toBeNull()
}

/**
 * Removing a vote that was never cast is rejected, for the voter and for a third party alike.
 *
 * 1. Submit two referenda; Charlie votes on the first only
 * 2. Charlie removes his vote on the second referendum
 * 3. Verify the call failed with `NotVoter`
 * 4. Dave removes Charlie's vote on the second referendum
 * 5. Verify the call failed with `NotVoter`, and Charlie's vote on the first referendum stands
 */
async function removeMissingVoteFailsTest(client: Client<any, any>) {
  const { charlie, dave } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit two referenda; Charlie votes on the first only
  const votedPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const otherPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(votedPoll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, charlie, votedPoll, { aye: true, conviction: 'Locked1x', balance: vote })
  const stateBefore = await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)

  // 2. Charlie removes a vote he never cast
  await sendTransaction(client.api.tx.convictionVoting.removeVote(null, otherPoll).signAsync(charlie))
  await client.dev.newBlock()

  // 3. NotVoter
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'voter removes a vote that does not exist',
  )
  await expectConvictionVotingError(client, 'NotVoter')

  // 4. Dave removes the same missing vote on Charlie's behalf
  await sendTransaction(
    client.api.tx.convictionVoting.removeOtherVote(charlie.address, SMALL_TIPPER_CLASS, otherPoll).signAsync(dave),
  )
  await client.dev.newBlock()

  // 5. NotVoter again, and Charlie's real vote stands
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'third party removes a vote that does not exist',
  )
  await expectConvictionVotingError(client, 'NotVoter')
  expect(await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readTally(client, votedPoll)).toEqual({ ayes: vote, nays: 0n, support: vote })
}

/**
 * After a referendum is rejected, votes on the winning side stay locked for their conviction's lock time, and every
 * other vote is free at once.
 *
 * The referendum is rejected, so the nays won. A winning vote with conviction keeps a prior lock that ends
 * `lock period x 1, 4 or 32` after the referendum ended, for 1x, 3x and 6x conviction. A winning vote without
 * conviction and a losing vote keep nothing, however high the loser's conviction.
 *
 * 1. Submit a referendum and bring it into its decision period
 * 2. Bob, Charlie and Dave vote nay with 1x, 3x and 6x conviction; Eve votes nay with none; Ferdie votes aye with 6x
 * 3. End the decision period, so that the referendum is rejected
 * 4. Each voter removes their vote, naming the class
 * 5. Verify the removals succeeded with no conviction voting event
 * 6. Verify the prior lock each voter is left with
 * 7. Each voter calls `unlock`
 * 8. Verify the three winners with conviction are still locked, and the other two are not
 */
async function removeVotesAfterRejectionTest(client: Client<any, any>) {
  const { bob, charlie, dave, eve, ferdie } = testAccounts
  const vote = voteAmount(client)
  const lockPeriod = client.api.consts.convictionVoting.voteLockingPeriod.toNumber()
  await fundTestAccounts(client)

  // 1. Submit a referendum and bring it into its decision period
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await startDeciding(client, poll, SMALL_TIPPER_CLASS)

  // 2. Four nays and one aye
  const ballots: { voter: KeyringPair; aye: boolean; conviction: string; lockPeriods: number }[] = [
    { voter: bob, aye: false, conviction: 'Locked1x', lockPeriods: 1 },
    { voter: charlie, aye: false, conviction: 'Locked3x', lockPeriods: 4 },
    { voter: dave, aye: false, conviction: 'Locked6x', lockPeriods: 32 },
    { voter: eve, aye: false, conviction: 'None', lockPeriods: 0 },
    { voter: ferdie, aye: true, conviction: 'Locked6x', lockPeriods: 0 },
  ]
  for (const { voter, aye, conviction } of ballots) {
    await sendTransaction(
      client.api.tx.convictionVoting.vote(poll, standardVote(aye, conviction, vote)).signAsync(voter),
    )
  }
  await client.dev.newBlock()
  for (const { voter, aye, conviction } of ballots) {
    await expectVotedEvent(client, voter, poll, { aye, conviction, balance: vote })
  }
  // Nays: 1 + 3 + 6 + 0.1 times the base amount. Ayes: Ferdie's 6.
  expect(await readTally(client, poll)).toEqual({ ayes: 6n * vote, nays: 10n * vote + vote / 10n, support: vote })

  // 3. End the decision period
  const end = await rejectReferendum(client, poll, SMALL_TIPPER_CLASS)

  // 4. Each voter removes their vote. The class is required, because the poll is over.
  for (const { voter } of ballots) {
    await sendTransaction(client.api.tx.convictionVoting.removeVote(SMALL_TIPPER_CLASS, poll).signAsync(voter))
  }
  await client.dev.newBlock()

  // 5. Removing a vote from a finished poll emits nothing
  await expectSuccessWithoutVotingEvents(client)

  // 6. Winners with conviction keep a prior lock counted from the end of the referendum
  for (const { voter, lockPeriods } of ballots) {
    const voting = await client.api.query.convictionVoting.votingFor(voter.address, SMALL_TIPPER_CLASS)
    assert(voting.isCasting)
    expect(voting.asCasting.votes).toHaveLength(0)
    const [until, amount] = voting.asCasting.prior
    if (lockPeriods > 0) {
      expect(until.toNumber()).toBe(end + lockPeriod * lockPeriods)
      expect(amount.toBigInt()).toBe(vote)
    } else {
      expect(until.toNumber()).toBe(0)
      expect(amount.toBigInt()).toBe(0n)
    }
  }

  // 7. Each voter calls `unlock`
  const unlock = (voter: KeyringPair) =>
    sendTransaction(client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, voter.address).signAsync(voter))
  const winnerUnlockEvents = await unlock(bob)
  await unlock(charlie)
  await unlock(dave)
  await unlock(eve)
  const loserUnlockEvents = await unlock(ferdie)
  await client.dev.newBlock()
  await checkEvents(winnerUnlockEvents, 'convictionVoting').toMatchSnapshot('unlock of a winning vote with conviction')
  await checkEvents(loserUnlockEvents, 'convictionVoting').toMatchSnapshot('unlock of a losing vote with conviction')

  // 8. Only the winners with conviction are still locked
  for (const { voter, lockPeriods } of ballots) {
    if (lockPeriods > 0) {
      expect(await readClassLocks(client, voter.address)).toEqual([[SMALL_TIPPER_CLASS, vote]])
      expect(await readVotingLock(client, voter.address)).toBe(vote)
    } else {
      expect(await readClassLocks(client, voter.address)).toEqual([])
      expect(await readVotingLock(client, voter.address)).toBeNull()
    }
  }
}

/**
 * A third party cannot remove someone's vote while the poll is ongoing.
 *
 * 1. Submit a referendum; Charlie votes on it
 * 2. Dave removes Charlie's vote
 * 3. Verify the call failed with `NoPermission`
 * 4. Verify Charlie's vote and the tally are unchanged
 */
async function removeOtherVoteDuringPollFailsTest(client: Client<any, any>) {
  const { charlie, dave } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie votes on it
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, charlie, poll, { aye: true, conviction: 'Locked1x', balance: vote })
  const stateBefore = await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)

  // 2. Dave removes Charlie's vote
  await sendTransaction(
    client.api.tx.convictionVoting.removeOtherVote(charlie.address, SMALL_TIPPER_CLASS, poll).signAsync(dave),
  )
  await client.dev.newBlock()

  // 3. NoPermission
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'third party removes a vote during the poll',
  )
  await expectConvictionVotingError(client, 'NoPermission')

  // 4. Charlie's vote and the tally are unchanged
  expect(await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readTally(client, poll)).toEqual({ ayes: vote, nays: 0n, support: vote })
}

/**
 * A third party can remove a winning vote only once its lock time is over, and can then unlock the voter's balance.
 *
 * The lock of a 1x vote ends one lock period after the referendum ended. Waiting that long is not practical, so the
 * test moves the recorded end of the referendum instead, first so that the lock ends one block after Dave's call
 * runs, then so that it ends exactly when the call runs.
 *
 * 1. Submit a referendum, bring it into its decision period; Bob votes nay with 1x conviction
 * 2. End the decision period, so that the referendum is rejected and Bob's vote won
 * 3. Dave removes Bob's vote, and the call fails with `NoPermissionYet`
 * 4. Move the end of the referendum so that the lock ends one block after Dave's next call runs
 * 5. Dave removes Bob's vote, and the call fails with `NoPermissionYet`; Bob's vote is unchanged
 * 6. Move the end of the referendum so that the lock ends exactly when Dave's next call runs
 * 7. Dave removes Bob's vote, and the call succeeds with no event and leaves no prior lock
 * 8. Dave calls `unlock` for Bob, and Bob's balance lock is removed
 */
async function removeOtherVoteAfterLockTest(client: Client<any, any>) {
  const { bob, dave } = testAccounts
  const vote = voteAmount(client)
  const blockProvider = client.config.properties.schedulerBlockProvider
  const lockPeriod = client.api.consts.convictionVoting.voteLockingPeriod.toNumber()
  // A signed call in the next block runs with the current block-provider number plus this step.
  const step = blockProviderOffset(blockProvider, (client.config.properties as any).relayBlocksPerParaBlock)
  await fundTestAccounts(client)

  // 1. Submit a referendum, bring it into its decision period; Bob votes nay with 1x conviction
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await startDeciding(client, poll, SMALL_TIPPER_CLASS)
  await sendTransaction(client.api.tx.convictionVoting.vote(poll, standardVote(false, 'Locked1x', vote)).signAsync(bob))
  await client.dev.newBlock()
  await expectVotedEvent(client, bob, poll, { aye: false, conviction: 'Locked1x', balance: vote })

  // 2. End the decision period
  await rejectReferendum(client, poll, SMALL_TIPPER_CLASS)
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)
  const removeOtherVote = () =>
    client.api.tx.convictionVoting.removeOtherVote(bob.address, SMALL_TIPPER_CLASS, poll).signAsync(dave)

  // 3. A full lock period remains
  await sendTransaction(removeOtherVote())
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'third party removes a winning vote right after the poll',
  )
  await expectConvictionVotingError(client, 'NoPermissionYet')

  // 4. The lock ends one block after Dave's next call runs
  let callRunsAt = (await getBlockNumber(client.api, blockProvider)) + step
  await setRejectionBlock(client, poll, callRunsAt + 1 - lockPeriod)

  // 5. Still too early
  await sendTransaction(removeOtherVote())
  await client.dev.newBlock()
  expect(await getBlockNumber(client.api, blockProvider)).toBe(callRunsAt)
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'third party removes a winning vote one block before its lock ends',
  )
  await expectConvictionVotingError(client, 'NoPermissionYet')
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)

  // 6. The lock ends exactly when Dave's next call runs
  callRunsAt = (await getBlockNumber(client.api, blockProvider)) + step
  await setRejectionBlock(client, poll, callRunsAt - lockPeriod)

  // 7. The removal goes through, silently, and leaves no prior lock because the lock time is over
  await sendTransaction(removeOtherVote())
  await client.dev.newBlock()
  expect(await getBlockNumber(client.api, blockProvider)).toBe(callRunsAt)
  await expectSuccessWithoutVotingEvents(client)
  const voting = await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes).toHaveLength(0)
  expect(voting.asCasting.prior[1].toBigInt()).toBe(0n)
  expect(await readVotingLock(client, bob.address)).toBe(vote)

  // 8. Anyone can then unlock Bob's balance
  const unlockEvents = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, bob.address).signAsync(dave),
  )
  await client.dev.newBlock()
  await checkEvents(unlockEvents, 'convictionVoting').toMatchSnapshot('third party unlocks an expired vote')
  expect(await readClassLocks(client, bob.address)).toEqual([])
  expect(await readVotingLock(client, bob.address)).toBeNull()
}

/**
 * A losing vote can be removed by anyone as soon as the poll is over, whatever its conviction.
 *
 * On this runtime a losing vote carries no lock time, so it counts as expired the moment the referendum ends.
 *
 * 1. Submit a referendum, bring it into its decision period; Ferdie votes aye with 6x conviction, and Eve outvotes
 *    him with a larger nay
 * 2. End the decision period, so that the referendum is rejected and Ferdie's vote lost
 * 3. Dave removes Ferdie's vote
 * 4. Verify the call succeeded with no conviction voting event, and the vote is gone with no prior lock
 * 5. Dave calls `unlock` for Ferdie, and Ferdie's balance lock is removed
 */
async function removeOtherLosingVoteTest(client: Client<any, any>) {
  const { dave, eve, ferdie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum, bring it into its decision period; Ferdie votes aye with 6x conviction. Eve's nay is
  // larger than his weighted aye: a referendum with only ayes would pass at the end of its decision period.
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await startDeciding(client, poll, SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked6x', vote)).signAsync(ferdie),
  )
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(false, 'Locked1x', 10n * vote)).signAsync(eve),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, ferdie, poll, { aye: true, conviction: 'Locked6x', balance: vote })
  expect(await readTally(client, poll)).toEqual({ ayes: 6n * vote, nays: 10n * vote, support: vote })

  // 2. End the decision period
  await rejectReferendum(client, poll, SMALL_TIPPER_CLASS)
  expect(await readVotingLock(client, ferdie.address)).toBe(vote)

  // 3. Dave removes Ferdie's vote
  await sendTransaction(
    client.api.tx.convictionVoting.removeOtherVote(ferdie.address, SMALL_TIPPER_CLASS, poll).signAsync(dave),
  )
  await client.dev.newBlock()

  // 4. The removal succeeded silently and left no prior lock
  await expectSuccessWithoutVotingEvents(client)
  const voting = await client.api.query.convictionVoting.votingFor(ferdie.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes).toHaveLength(0)
  expect(voting.asCasting.prior[1].toBigInt()).toBe(0n)

  // 5. Dave unlocks Ferdie's balance
  const unlockEvents = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, ferdie.address).signAsync(dave),
  )
  await client.dev.newBlock()
  await checkEvents(unlockEvents, 'convictionVoting').toMatchSnapshot('third party unlocks a losing vote')
  expect(await readClassLocks(client, ferdie.address)).toEqual([])
  expect(await readVotingLock(client, ferdie.address)).toBeNull()
}

/**
 * `remove_other_vote` with oneself as the target behaves like `remove_vote`: it works while the poll is ongoing.
 *
 * 1. Submit a referendum; Charlie votes on it
 * 2. Charlie calls `remove_other_vote` with himself as the target
 * 3. Verify the `VoteRemoved` event
 * 4. Verify the tally is empty and the vote is gone
 */
async function removeOtherVoteOnSelfTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie votes on it
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  expect(await readTally(client, poll)).toEqual({ ayes: vote, nays: 0n, support: vote })

  // 2. Charlie removes his own vote through `remove_other_vote`
  const removeEvents = await sendTransaction(
    client.api.tx.convictionVoting.removeOtherVote(charlie.address, SMALL_TIPPER_CLASS, poll).signAsync(charlie),
  )
  await client.dev.newBlock()

  // 3. `VoteRemoved` carries the removed vote
  await checkEvents(removeEvents, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('own vote removed through remove_other_vote')
  await expectVoteRemovedEvent(client, charlie, poll, { aye: true, conviction: 'Locked1x', balance: vote })

  // 4. The tally is empty and the vote is gone
  expect(await readTally(client, poll)).toEqual({ ayes: 0n, nays: 0n, support: 0n })
  const voting = await client.api.query.convictionVoting.votingFor(charlie.address, SMALL_TIPPER_CLASS)
  assert(voting.isCasting)
  expect(voting.asCasting.votes).toHaveLength(0)
}

/**
 * `remove_vote` by an account that delegates the class succeeds and changes nothing.
 *
 * A delegator has no votes of its own to remove, and the pallet treats that as nothing to do rather than as an
 * error. The test pins this, so that a caller does not read the success as "a vote was removed".
 *
 * 1. Bob delegates the main class to Charlie; submit a referendum
 * 2. Bob calls `remove_vote` for that referendum, naming the class
 * 3. Verify the call succeeded with no conviction voting event
 * 4. Verify Bob's delegation is unchanged
 */
async function removeVoteWhileDelegatingTest(client: Client<any, any>) {
  const { bob, charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. Bob delegates the main class to Charlie; submit a referendum
  await sendTransaction(
    client.api.tx.convictionVoting.delegate(SMALL_TIPPER_CLASS, charlie.address, 'Locked1x', vote).signAsync(bob),
  )
  await client.dev.newBlock()
  expect((await client.api.query.convictionVoting.votingFor(bob.address, SMALL_TIPPER_CLASS)).isDelegating).toBe(true)
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const stateBefore = await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)

  // 2. Bob calls `remove_vote`
  await sendTransaction(client.api.tx.convictionVoting.removeVote(SMALL_TIPPER_CLASS, poll).signAsync(bob))
  await client.dev.newBlock()

  // 3. Success, with no event
  await expectSuccessWithoutVotingEvents(client)

  // 4. The delegation is unchanged
  expect(await readVotingState(client, bob.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
}

/// -------
/// Unlocking and class locks
/// -------

/**
 * Locks are tracked per class. The balance lock on the account is the largest class lock, and each class is released
 * by its own `unlock` call.
 *
 * 1. Submit one referendum on the main class and one on a second class
 * 2. Charlie votes the base amount on the first and twice that on the second
 * 3. Verify one lock per class, and a balance lock equal to the larger one
 * 4. Charlie removes both votes; the locks are unchanged
 * 5. Charlie unlocks the second class, and the balance lock drops to the main class's lock
 * 6. Charlie unlocks the main class, and no lock is left
 */
async function classLocksReleasedPerClassTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  await fundTestAccounts(client)

  // 1. One referendum per class
  const mainPoll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  const secondPoll = await submitReferendum(client, 'BigTipper', BIG_TIPPER_CLASS)

  // 2. Charlie votes on both
  await sendTransaction(
    client.api.tx.convictionVoting.vote(mainPoll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, charlie, mainPoll, { aye: true, conviction: 'Locked1x', balance: vote })
  await sendTransaction(
    client.api.tx.convictionVoting.vote(secondPoll, standardVote(true, 'Locked1x', 2n * vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, charlie, secondPoll, { aye: true, conviction: 'Locked1x', balance: 2n * vote })

  // 3. One lock per class; the balance lock is the larger one, not the sum
  const bothLocks: [number, bigint][] = [
    [SMALL_TIPPER_CLASS, vote],
    [BIG_TIPPER_CLASS, 2n * vote],
  ]
  expect(await readClassLocks(client, charlie.address)).toEqual(bothLocks)
  expect(await readVotingLock(client, charlie.address)).toBe(2n * vote)

  // 4. Removing the votes does not touch the locks
  const firstRemoval = await sendTransaction(
    client.api.tx.convictionVoting.removeVote(null, mainPoll).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(firstRemoval, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('vote removed in the main class')
  const secondRemoval = await sendTransaction(
    client.api.tx.convictionVoting.removeVote(null, secondPoll).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(secondRemoval, 'convictionVoting')
    .redact({ redactKeys: /^pollIndex$/ })
    .toMatchSnapshot('vote removed in the second class')
  expect(await readClassLocks(client, charlie.address)).toEqual(bothLocks)
  expect(await readVotingLock(client, charlie.address)).toBe(2n * vote)

  // 5. Unlocking the second class leaves the main class's lock
  const secondUnlock = await sendTransaction(
    client.api.tx.convictionVoting.unlock(BIG_TIPPER_CLASS, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(secondUnlock, 'convictionVoting').toMatchSnapshot('unlock of the second class')
  expect(await readClassLocks(client, charlie.address)).toEqual([[SMALL_TIPPER_CLASS, vote]])
  expect(await readVotingLock(client, charlie.address)).toBe(vote)

  // 6. Unlocking the main class leaves nothing
  const mainUnlock = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(mainUnlock, 'convictionVoting').toMatchSnapshot('unlock of the main class')
  expect(await readClassLocks(client, charlie.address)).toEqual([])
  expect(await readVotingLock(client, charlie.address)).toBeNull()
}

/**
 * `unlock` succeeds and emits `VoteUnlocked` even when it releases nothing, and even for a class that is not a
 * track.
 *
 * The call only recomputes what the class still needs. The event therefore says that the lock was recomputed, not
 * that funds were freed, which is why every other test checks the lock amount after an `unlock`.
 *
 * 1. Submit a referendum; Charlie votes on it
 * 2. Charlie calls `unlock` for the class of his open vote
 * 3. Verify `VoteUnlocked` was emitted and the lock is unchanged
 * 4. Charlie calls `unlock` for a class that is not a track
 * 5. Verify `VoteUnlocked` was emitted for that class and the lock is unchanged
 */
async function unlockWithNothingToReleaseTest(client: Client<any, any>) {
  const { charlie } = testAccounts
  const vote = voteAmount(client)
  const unknownClass = 99
  expect(client.api.consts.referenda.tracks.map(([id]) => id.toNumber())).not.toContain(unknownClass)
  await fundTestAccounts(client)

  // 1. Submit a referendum; Charlie votes on it
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'Locked1x', vote)).signAsync(charlie),
  )
  await client.dev.newBlock()
  await expectVotedEvent(client, charlie, poll, { aye: true, conviction: 'Locked1x', balance: vote })
  const stateBefore = await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)

  // 2. Charlie unlocks the class of his open vote
  const openClassUnlock = await sendTransaction(
    client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()

  // 3. The event is emitted, and nothing is released
  await checkEvents(openClassUnlock, 'convictionVoting').toMatchSnapshot('unlock of a class with an open vote')
  expect(await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, charlie.address)).toBe(vote)

  // 4. Charlie unlocks a class that is not a track
  const unknownClassUnlock = await sendTransaction(
    client.api.tx.convictionVoting.unlock(unknownClass, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()

  // 5. The event names the unknown class, and nothing is released
  await checkEvents(unknownClassUnlock, 'convictionVoting').toMatchSnapshot('unlock of a class that is not a track')
  const events = await client.api.query.system.events()
  const unlocked = events.filter(({ event }) => client.api.events.convictionVoting.VoteUnlocked.is(event))
  expect(unlocked).toHaveLength(1)
  const unlockedEvent = unlocked[0].event
  assert(client.api.events.convictionVoting.VoteUnlocked.is(unlockedEvent))
  expect(unlockedEvent.data.class.toNumber()).toBe(unknownClass)
  expect(await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, charlie.address)).toBe(vote)
}

/**
 * A balance locked by a vote cannot be transferred, and becomes transferable again once the vote is removed and the
 * class unlocked.
 *
 * This checks the lock where it matters, in the balances pallet. The vote here is a hundred times the base amount,
 * so that the transfer can sit well inside the locked part of the balance whatever the transaction fees are.
 *
 * 1. Submit a referendum; Charlie votes with a tenth of his funded balance
 * 2. Charlie transfers an amount that he owns but that reaches into the locked balance
 * 3. Verify the transfer failed with the token error `Frozen`, and Dave received nothing
 * 4. Charlie removes his vote and unlocks the class
 * 5. Charlie sends the same transfer again
 * 6. Verify Dave received exactly the transferred amount
 */
async function lockedBalanceCannotBeTransferredTest(client: Client<any, any>) {
  const { charlie, dave } = testAccounts
  const lockedAmount = 100n * voteAmount(client)
  await fundTestAccounts(client)
  const freeOf = async (address: string) => (await client.api.query.system.account(address)).data.free.toBigInt()

  // 1. Submit a referendum; Charlie votes with a tenth of his funded balance
  const poll = await submitReferendum(client, 'SmallTipper', SMALL_TIPPER_CLASS)
  await sendTransaction(
    client.api.tx.convictionVoting.vote(poll, standardVote(true, 'None', lockedAmount)).signAsync(charlie),
  )
  await client.dev.newBlock()
  expect(await readVotingLock(client, charlie.address)).toBe(lockedAmount)

  // 2. The transfer leaves Charlie with half of the locked amount, less fees: affordable, but not unlocked
  const transferAmount = (await freeOf(charlie.address)) - lockedAmount / 2n
  const daveBefore = await freeOf(dave.address)
  const transfer = () => client.api.tx.balances.transferKeepAlive(dave.address, transferAmount).signAsync(charlie)
  await sendTransaction(transfer())
  await client.dev.newBlock()

  // 3. The balances pallet refused to move frozen funds
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'transfer of a locked balance',
  )
  let events = await client.api.query.system.events()
  const failures = events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failures).toHaveLength(1)
  const failure = failures[0].event
  assert(client.api.events.system.ExtrinsicFailed.is(failure))
  const { dispatchError } = failure.data
  assert(dispatchError.isToken, `expected a token error, got ${dispatchError.type}`)
  expect(dispatchError.asToken.isFrozen).toBe(true)
  expect(await freeOf(dave.address)).toBe(daveBefore)

  // 4. Charlie removes his vote and unlocks the class
  await sendTransaction(client.api.tx.convictionVoting.removeVote(null, poll).signAsync(charlie))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.convictionVoting.unlock(SMALL_TIPPER_CLASS, charlie.address).signAsync(charlie))
  await client.dev.newBlock()
  expect(await readVotingLock(client, charlie.address)).toBeNull()

  // 5. The same transfer again
  const transferEvents = await sendTransaction(transfer())
  await client.dev.newBlock()

  // 6. It went through for the exact amount
  await checkEvents(transferEvents, { section: 'balances', method: 'Transfer' }).toMatchSnapshot(
    'transfer after unlocking',
  )
  events = await client.api.query.system.events()
  expect(events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))).toHaveLength(0)
  expect(await freeOf(dave.address)).toBe(daveBefore + transferAmount)
}

/// -------
/// Origins
/// -------

/**
 * Every call of the pallet needs a signed origin. Dispatched as Root, each one fails with `BadOrigin`.
 *
 * All six calls are open to any account, so the one origin worth rejecting is a privileged one. The calls are
 * injected into the scheduler together and run as Root in the next block.
 *
 * 1. Build the six calls, with Charlie as the account they would act on
 * 2. Schedule all of them with the Root origin
 * 3. Verify the scheduler dispatched six calls, each failing with `BadOrigin`
 * 4. Verify nothing was recorded or locked for Charlie
 */
async function rootOriginRejectedTest(client: Client<any, any>) {
  const { charlie, dave } = testAccounts
  const vote = voteAmount(client)
  const blockProvider = client.config.properties.schedulerBlockProvider
  const tx = client.api.tx.convictionVoting
  await fundTestAccounts(client)
  const stateBefore = await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)

  // 1. The six calls. The poll index is irrelevant, because the origin is checked first.
  const calls = [
    tx.vote(0, standardVote(true, 'None', vote)),
    tx.delegate(SMALL_TIPPER_CLASS, dave.address, 'None', vote),
    tx.undelegate(SMALL_TIPPER_CLASS),
    tx.unlock(SMALL_TIPPER_CLASS, charlie.address),
    tx.removeVote(SMALL_TIPPER_CLASS, 0),
    tx.removeOtherVote(charlie.address, SMALL_TIPPER_CLASS, 0),
  ].map((call) => call.method.toHex())
  // The scheduler only stores calls of up to 128 bytes inline: `(hex length - 2) / 2` bytes each.
  for (const call of calls) {
    expect((call.length - 2) / 2).toBeLessThanOrEqual(128)
  }

  // 2. Schedule all of them as Root
  const scheduledAt = await getBlockNumber(client.api, blockProvider)
  await scheduleInlineCallListWithSameOrigin(client, calls, { system: 'Root' }, blockProvider)
  await client.dev.newBlock()

  // 3. Six dispatches, each failing with BadOrigin
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('conviction voting calls dispatched as Root')
  const events = await client.api.query.system.events()
  const dispatched = events.filter(
    ({ event }) => client.api.events.scheduler.Dispatched.is(event) && event.data.task[0].toNumber() === scheduledAt,
  )
  expect(dispatched).toHaveLength(calls.length)
  for (const { event } of dispatched) {
    assert(client.api.events.scheduler.Dispatched.is(event))
    assert(event.data.result.isErr, 'a Root dispatch of a signed-only call should fail')
    expect(event.data.result.asErr.isBadOrigin).toBe(true)
  }

  // 4. Nothing recorded or locked
  expect(await readVotingState(client, charlie.address, SMALL_TIPPER_CLASS)).toEqual(stateBefore)
  expect(await readVotingLock(client, charlie.address)).toBeNull()
}

/// -------
/// Test tree
/// -------

/**
 * Conviction voting E2E tests for a chain whose polls are referenda.
 *
 * One client is shared by the whole suite and restored to the forked block before each test.
 */
export function convictionVotingE2ETests<
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
      {
        kind: 'describe',
        label: 'Voting',
        children: [
          {
            kind: 'test',
            label: 'vote - conviction weights the tally and locks the balance',
            testFn: () => voteWeightsTallyAndLocksTest(client),
          },
          {
            kind: 'test',
            label: 'vote again on the same poll - vote replaced, lock kept until unlock',
            testFn: () => voteAgainReplacesVoteTest(client),
          },
          {
            kind: 'test',
            label: 'vote on two polls in one class - lock is the largest vote',
            testFn: () => voteOnTwoPollsLocksLargestTest(client),
          },
          {
            kind: 'test',
            label: 'vote more than the total balance - InsufficientFunds',
            testFn: () => voteAboveTotalBalanceFailsTest(client),
          },
          {
            kind: 'test',
            label: 'vote on a cancelled poll - NotOngoing',
            testFn: () => voteOnCancelledPollFailsTest(client),
          },
          {
            kind: 'test',
            label: 'vote while delegating - AlreadyDelegating, other classes still open',
            testFn: () => voteWhileDelegatingFailsTest(client),
          },
          {
            kind: 'test',
            label: 'vote up to MaxVotes - last vote accepted, next one MaxVotesReached, change allowed',
            testFn: () => voteUpToMaxVotesTest(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Delegation',
        children: [
          {
            kind: 'test',
            label: "delegate - Delegated, delegations added to the target's open vote",
            testFn: () => delegateAddsToTargetVoteTest(client),
          },
          {
            kind: 'test',
            label: 'undelegate - Undelegated, tally restored, conviction lock kept',
            testFn: () => undelegateKeepsConvictionLockTest(client),
          },
          {
            kind: 'test',
            label: 'undelegate without conviction - unlock frees the balance at once',
            testFn: () => undelegateWithoutConvictionUnlocksTest(client),
          },
          {
            kind: 'test',
            label: 'delegate to self - Nonsense',
            testFn: () => delegateToSelfFailsTest(client),
          },
          {
            kind: 'test',
            label: 'delegate on a class that is not a track - BadClass',
            testFn: () => delegateUnknownClassFailsTest(client),
          },
          {
            kind: 'test',
            label: 'delegate more than the total balance - InsufficientFunds',
            testFn: () => delegateAboveTotalBalanceFailsTest(client),
          },
          {
            kind: 'test',
            label: 'delegate twice in one class - AlreadyDelegating',
            testFn: () => delegateTwiceFailsTest(client),
          },
          {
            kind: 'test',
            label: 'delegate while voting in the class - AlreadyVoting',
            testFn: () => delegateWhileVotingFailsTest(client),
          },
          {
            kind: 'test',
            label: 'undelegate without a delegation - NotDelegating',
            testFn: () => undelegateWithoutDelegationFailsTest(client),
          },
          {
            kind: 'test',
            label: 'delegate to a split voter - delegations not counted in the tally',
            testFn: () => delegateToSplitVoterTest(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Removing votes',
        children: [
          {
            kind: 'test',
            label: 'remove vote during the poll - VoteRemoved, tally restored, lock kept until unlock',
            testFn: () => removeVoteDuringPollTest(client),
          },
          {
            kind: 'test',
            label: 'remove vote after cancellation - ClassNeeded without a class, removed silently with one',
            testFn: () => removeVoteAfterCancellationTest(client),
          },
          {
            kind: 'test',
            label: 'remove a vote that does not exist - NotVoter',
            testFn: () => removeMissingVoteFailsTest(client),
          },
          {
            kind: 'test',
            label: 'remove votes after rejection - winning votes locked by conviction, the rest freed',
            testFn: () => removeVotesAfterRejectionTest(client),
          },
          {
            kind: 'test',
            label: 'remove other vote during the poll - NoPermission',
            testFn: () => removeOtherVoteDuringPollFailsTest(client),
          },
          {
            kind: 'test',
            label: 'remove other vote on a winning vote - NoPermissionYet until the lock ends',
            testFn: () => removeOtherVoteAfterLockTest(client),
          },
          {
            kind: 'test',
            label: 'remove other vote on a losing vote - removed by anyone after the poll',
            testFn: () => removeOtherLosingVoteTest(client),
          },
          {
            kind: 'test',
            label: 'remove other vote on oneself - same as remove vote',
            testFn: () => removeOtherVoteOnSelfTest(client),
          },
          {
            kind: 'test',
            label: 'remove vote while delegating - succeeds and changes nothing',
            testFn: () => removeVoteWhileDelegatingTest(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Unlocking and class locks',
        children: [
          {
            kind: 'test',
            label: 'class locks - account lock follows the largest class, released per class',
            testFn: () => classLocksReleasedPerClassTest(client),
          },
          {
            kind: 'test',
            label: 'unlock with nothing to release - VoteUnlocked, lock unchanged',
            testFn: () => unlockWithNothingToReleaseTest(client),
          },
          {
            kind: 'test',
            label: 'locked balance cannot be transferred until unlocked',
            testFn: () => lockedBalanceCannotBeTransferredTest(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Origins',
        children: [
          {
            kind: 'test',
            label: 'calls from a Root origin - BadOrigin',
            testFn: () => rootOriginRejectedTest(client),
          },
        ],
      },
    ],
  }
}
