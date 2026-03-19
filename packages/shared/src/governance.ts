import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type DescribeNode, type RootTestTree, setupNetworks, type TestNode } from '@e2e-test/shared'

import type { Option, u32 } from '@polkadot/types'
import type {
  PalletConvictionVotingVoteCasting,
  PalletConvictionVotingVoteVoting,
  PalletReferendaDeposit,
  PalletReferendaReferendumInfoConvictionVotingTally,
  PalletReferendaReferendumStatusConvictionVotingTally,
} from '@polkadot/types/lookup'
import type { ITuple } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { match } from 'ts-pattern'
import {
  check,
  checkEvents,
  checkSystemEvents,
  expectPjsEqual,
  getBlockNumber,
  objectCmp,
  scheduleInlineCallWithOrigin,
} from './helpers/index.js'

/// -------
/// Types
/// -------

export interface GovernanceTrackConfig {
  trackId: number
  trackName: string
  /** Must match the runtime's `Origins` enum variant (e.g. `'SmallTipper'`). */
  originName: string
}

export interface GovernanceTestConfig {
  testSuiteName: string
  tracks: GovernanceTrackConfig[]
}

/// -------
/// Helpers
/// -------

const devAccounts = defaultAccountsSr25519

/**
 * Compare the selected properties of two referenda.
 *
 * Fails if any of the properties to be compared is different.
 *
 * It can be desirable to compare a referendum in its pre- and post-block-execution states.
 * For example:
 * 1. from the time its decision deposited is placed until its preparation period elapses, no field
 *    of the referendum may change
 *
 *     a. to know which block in the iterated comparisons caused the failure, an optional error
 *      message parameter is passable
 * 2. after placing a vote, the referendum's tally and alarm should change, but nothing else
 *
 * @param ref1
 * @param ref2
 * @param propertiesToBeSkipped List of properties to not be included in the referenda comparison
 * @param errorMsg Additional error message when using this function inside a loop, to
 *        identify failing iteration.
 */
function referendumCmp(
  ref1: PalletReferendaReferendumStatusConvictionVotingTally,
  ref2: PalletReferendaReferendumStatusConvictionVotingTally,
  propertiesToBeSkipped: string[],
  optErrorMsg?: string,
) {
  const properties = [
    'track',
    'origin',
    'proposal',
    'enactment',
    'submitted',
    'submissionDeposit',
    'decisionDeposit',
    'deciding',
    'tally',
    'inQueue',
    'alarm',
  ]

  const msgFun = (p: string) =>
    `Referenda differed on property \`${p}\`
      Left: ${ref1[p]}
      Right: ${ref2[p]}`

  objectCmp(ref1, ref2, properties, propertiesToBeSkipped, msgFun, optErrorMsg)
}

/// -------
/// -------
/// -------

/**
 * Test the process of submitting a referendum for a treasury spend
 */
export async function submitReferendumTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Fund test accounts with enough for submission deposit + fees.
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: (submissionDeposit * 10n).toString() } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: 10e10 } }],
      ],
    },
  })

  // Get the referendum's intended track data

  const referendaTracks = client.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.toString().startsWith('small_tipper'))!

  // Flush any pre-existing scheduled calls from the fork block so they don't
  // interfere with our referendum index.
  await client.dev.newBlock()

  const referendumIndex = (await client.api.query.referenda.referendumCount()).toNumber()

  /**
   * Submit a new referendum
   */
  const submissionTx = client.api.tx.referenda.submit(
    {
      Origins: 'SmallTipper',
    } as any,
    {
      Inline: client.api.tx.system.remark('hello').method.toHex(),
    },
    {
      After: 1,
    },
  )
  const submissionEvents = await sendTransaction(submissionTx.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // Fields to be removed, check comment below.
  const unwantedFields = /index/
  await checkEvents(submissionEvents, 'referenda')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum submission events')

  /**
   * Check the created referendum's data
   */
  let referendumDataOpt = (await client.api.query.referenda.referendumInfoFor(
    referendumIndex,
  )) as unknown as Option<PalletReferendaReferendumInfoConvictionVotingTally>
  assert(referendumDataOpt.isSome, "submitted referendum's data cannot be `None`")
  let referendumData: PalletReferendaReferendumInfoConvictionVotingTally = referendumDataOpt.unwrap()

  // These fields must be excised from the queried referendum data before being put in the test
  // snapshot.
  // These fields contain epoch-sensitive data, which will cause spurious test failures
  // periodically.
  const unwantedFields2 = /alarm|submitted/
  await check(referendumData)
    .redact({ removeKeys: unwantedFields2 })
    .toMatchSnapshot('referendum info after submission')

  expect(referendumData.isOngoing).toBe(true)
  // Ongoing referendum data, prior to the decision deposit.
  const ongoingReferendum: PalletReferendaReferendumStatusConvictionVotingTally = referendumData.asOngoing

  // Check the entirety of the stored referendum's data

  expect(ongoingReferendum.track.toNumber()).toBe(smallTipper[0].toNumber())
  expect(ongoingReferendum.origin.toJSON()).toMatchObject({ origins: 'SmallTipper' })

  expect(ongoingReferendum.proposal.asInline.toHex()).toBe(client.api.tx.system.remark('hello').method.toHex())

  // The referendum was above set to be enacted 1 block after its passing.
  expect(ongoingReferendum.enactment.isAfter).toBe(true)
  expect(ongoingReferendum.enactment.asAfter.toNumber()).toBe(1)

  expect(ongoingReferendum.submissionDeposit.who.toString()).toBe(
    encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding),
  )
  expect(ongoingReferendum.submissionDeposit.amount.toNumber()).toBe(
    client.api.consts.referenda.submissionDeposit.toNumber(),
  )

  // Immediately after a referendum's submission, it will not have a decision deposit,
  // which it will need to begin the decision period.
  expect(ongoingReferendum.decisionDeposit.isNone).toBe(true)
  expect(ongoingReferendum.deciding.isNone).toBe(true)

  // Current voting state of the referendum.
  const votes = {
    ayes: 0,
    nays: 0,
    support: 0,
  }

  // Check that voting data is empty
  await check(ongoingReferendum.tally).toMatchObject(votes)

  // The referendum should not have been put in a queue - this test assumes there's room in the referendum's
  // track.
  expect(ongoingReferendum.inQueue.isFalse).toBe(true)

  // Check the alarm
  expect(ongoingReferendum.alarm.isSome).toBe(true)
  const undecidingTimeoutAlarm = ongoingReferendum.alarm.unwrap()[0]
  const blocksUntilAlarm = undecidingTimeoutAlarm.sub(ongoingReferendum.submitted)
  // Check that the referendum's alarm is set to ring after the (globally predetermined) timeout
  // of 14 days, or 201600 blocks.
  expect(blocksUntilAlarm.toNumber()).toBe(client.api.consts.referenda.undecidingTimeout.toNumber())
  const alarm = [undecidingTimeoutAlarm, [undecidingTimeoutAlarm, 0]]
  expect(ongoingReferendum.alarm.unwrap().eq(alarm)).toBe(true)

  /**
   * Simulate a timeout caused by an unplaced decision deposit.
   *
   * 1. backdate `submitted` so that `submitted + undecidingTimeout` falls on the next local block
   * 2. set the alarm to that same block
   * 3. schedule a `nudgeReferendum` call so the runtime services the alarm
   *
   * The referendum's timing fields (`submitted`, alarm) use local block numbers.
   * The scheduler may use a different provider, so the nudge is scheduled via the helper.
   */

  const undecidedTimeout = client.api.consts.referenda.undecidingTimeout.toNumber()
  const localBlock = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const alarmBlock = localBlock + 1
  const newSubmitted = alarmBlock - undecidedTimeout

  await client.dev.setStorage({
    Referenda: {
      ReferendumInfoFor: [
        [
          [referendumIndex],
          {
            Ongoing: {
              track: ongoingReferendum.track,
              origin: ongoingReferendum.origin,
              proposal: ongoingReferendum.proposal,
              enactment: ongoingReferendum.enactment,
              submitted: newSubmitted,
              submissionDeposit: ongoingReferendum.submissionDeposit,
              decisionDeposit: ongoingReferendum.decisionDeposit,
              deciding: ongoingReferendum.deciding,
              tally: ongoingReferendum.tally,
              inQueue: ongoingReferendum.inQueue,
              alarm: [alarmBlock, [alarmBlock, 0]],
            },
          },
        ],
      ],
    },
  })

  // Schedule the nudge via the helper — it handles non-local block number providers correctly.
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.nudgeReferendum(referendumIndex).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  // Check event for the timed-out referendum
  let events = await client.api.query.system.events()

  const timedOutEvents = events.filter(
    ({ event }) => client.api.events.referenda.TimedOut.is(event) && event.data[0].toNumber() === referendumIndex,
  )

  expect(timedOutEvents.length, 'timing out a referendum should emit 1 TimedOut event').toBe(1)

  const timedOutEvent = timedOutEvents[0]

  await check(timedOutEvent).toMatchSnapshot('timed-out referendum event')

  // Check the timed-out referendum's data

  referendumDataOpt = (await client.api.query.referenda.referendumInfoFor(
    referendumIndex,
  )) as unknown as Option<PalletReferendaReferendumInfoConvictionVotingTally>
  assert(referendumDataOpt.isSome, "submitted referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()
  expect(referendumData.isTimedOut).toBe(true)

  const timedOutRef: ITuple<[u32, Option<PalletReferendaDeposit>, Option<PalletReferendaDeposit>]> =
    referendumData.asTimedOut

  // [end_block, submission_deposit, decision_deposit]
  expect(timedOutRef[1].isSome, 'submission deposit should be present after timeout').toBe(true)
  expect(timedOutRef[1].unwrap().who.toString()).toBe(
    encodeAddress(defaultAccountsSr25519.alice.address, chain.properties.addressEncoding),
  )
  expect(timedOutRef[1].unwrap().amount.toBigInt()).toBe(client.api.consts.referenda.submissionDeposit.toBigInt())
  expect(timedOutRef[2].isNone, 'decision deposit should be absent (never placed)').toBe(true)

  // Attempt to refund the submission deposit

  const refundTx = client.api.tx.referenda.refundSubmissionDeposit(referendumIndex)
  await sendTransaction(refundTx.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  events = await client.api.query.system.events()

  const refundEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  // Timed out referenda cannot have their submission deposit refunded.
  const refundEvent = refundEvents[0]
  assert(client.api.events.system.ExtrinsicFailed.is(refundEvent.event))
  const dispatchError = refundEvent.event.data.dispatchError
  assert(dispatchError.isModule)

  expect(client.api.errors.referenda.BadStatus.is(dispatchError.asModule)).toBe(true)
}

/**
 * Test the process of
 * 1. submitting a referendum for a treasury spend
 * 2. placing its decision deposit
 * 3. awaiting the end of the preparation period
 * 4. voting on it after the decision period has commenced
 *
 *     4.1. using `vote`
 *
 *     4.2. using a split vote
 *
 *     4.3. using a split-abstain vote
 * 5. cancelling the referendum using the scheduler to insert a `Root`-origin call
 *
 *     5.1 checking that locks on submission/decision deposits are released
 *
 *     5.2 checking that voters' class locks and voting data are not affected
 *
 * 6. removing the votes cast
 *
 *     6.1 asserting that voting locks are preserved
 *
 *     6.2 asserting that voting funds are returned
 *
 * 7. refunding the submission and decision deposits
 */
export async function referendumLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Fund test accounts not already provisioned in the test chain spec.
  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.bob.address], { providers: 1, data: { free: 10e10 } }],
        [[devAccounts.charlie.address], { providers: 1, data: { free: 10e10 } }],
        [[devAccounts.dave.address], { providers: 1, data: { free: 10e10 } }],
        [[devAccounts.eve.address], { providers: 1, data: { free: 10e10 } }],
      ],
    },
  })

  /**
   * Submit a new referendum
   */

  const submissionTx = client.api.tx.referenda.submit(
    {
      Origins: 'SmallTipper',
    } as any,
    {
      Inline: client.api.tx.treasury.spendLocal(1e10, devAccounts.bob.address).method.toHex(),
    },
    {
      After: 1,
    },
  )
  const submissionEvents = await sendTransaction(submissionTx.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  // Fields to be removed, check comment below.
  let unwantedFields = /index/
  await checkEvents(submissionEvents, 'referenda')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum submission events')

  const subEvents = await client.api.query.system.events()
  const [refEvent] = subEvents.filter((record) => {
    const { event } = record
    return event.section === 'referenda' && event.method === 'Submitted'
  })
  assert(client.api.events.referenda.Submitted.is(refEvent.event))
  const refEventData = refEvent.event.data
  const referendumIndex = refEventData[0].toNumber()

  /**
   * Check the created referendum's data
   */

  let referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "submitted referendum's data cannot be `None`")
  let referendumData: PalletReferendaReferendumInfoConvictionVotingTally = referendumDataOpt.unwrap()
  // These fields must be excised from the queried referendum data before being put in the test
  // snapshot.
  // These fields contain epoch-sensitive data, which will cause spurious test failures
  // periodically.
  unwantedFields = /alarm|submitted/
  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum info before decision deposit')

  expect(referendumData.isOngoing).toBe(true)
  // Ongoing referendum data, prior to the decision deposit.
  const ongoingRefPreDecDep: PalletReferendaReferendumStatusConvictionVotingTally = referendumData.asOngoing

  assert(ongoingRefPreDecDep.alarm.isSome)
  const undecidingTimeoutAlarm = ongoingRefPreDecDep.alarm.unwrap()[0]
  const blocksUntilAlarm = undecidingTimeoutAlarm.sub(ongoingRefPreDecDep.submitted)
  // Check that the referendum's alarm is set to ring after the (globally predetermined) timeout
  // of 14 days, or 201600 blocks.
  expect(blocksUntilAlarm.toNumber()).toBe(client.api.consts.referenda.undecidingTimeout.toNumber())

  // The referendum was above set to be enacted 1 block after its passing.
  assert(ongoingRefPreDecDep.enactment.isAfter)
  expect(ongoingRefPreDecDep.enactment.asAfter.toNumber()).toBe(1)

  const referendaTracks = client.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.toString().startsWith('small_tipper'))!
  expect(ongoingRefPreDecDep.track.toNumber()).toBe(smallTipper[0].toNumber())
  await check(ongoingRefPreDecDep.origin).toMatchObject({
    origins: 'SmallTipper',
  })

  // Immediately after a referendum's submission, it will not have a decision deposit,
  // which it will need to begin the decision period.
  expect(ongoingRefPreDecDep.deciding.isNone).toBeTruthy()
  expect(ongoingRefPreDecDep.decisionDeposit.isNone).toBeTruthy()

  expect(ongoingRefPreDecDep.submissionDeposit.who.toString()).toBe(
    encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding),
  )
  expect(ongoingRefPreDecDep.submissionDeposit.amount.toString()).toBe(
    client.api.consts.referenda.submissionDeposit.toString(),
  )

  // Current voting state of the referendum.
  const votes = {
    ayes: 0,
    nays: 0,
    support: 0,
  }

  // Check that voting data is empty
  await check(ongoingRefPreDecDep.tally).toMatchObject(votes)

  /**
   * Place decision deposit
   */

  const decisionDepTx = client.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  const decisiondepEvents = await sendTransaction(decisionDepTx.signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // Once more, fields containing temporally-contigent information - block numbers - must be excised
  // from test data to avoid spurious failures after updating block numbers.
  unwantedFields = /alarm|index|submitted/

  await checkEvents(decisiondepEvents, 'referenda')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for bob's decision deposit")

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum info post decision deposit')

  expect(referendumData.isOngoing).toBe(true)
  const ongoingRefPostDecDep = referendumData.asOngoing

  // The referendum can only begin deciding after its track's preparation period has elapsed, even though
  // the decision deposit has been placed.
  expect(ongoingRefPostDecDep.deciding.isNone).toBeTruthy()
  assert(ongoingRefPostDecDep.decisionDeposit.isSome)

  expect(ongoingRefPostDecDep.decisionDeposit.unwrap().who.toString()).toBe(
    encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding),
  )
  expect(ongoingRefPostDecDep.decisionDeposit.unwrap().amount.toString()).toBe(
    smallTipper[1].decisionDeposit.toString(),
  )

  // The block at which the referendum's preparation period will end, and its decision period will begin.
  const preparePeriodWithOffset = smallTipper[1].preparePeriod.add(ongoingRefPostDecDep.submitted)

  assert(ongoingRefPostDecDep.alarm.isSome)
  // The decision deposit has been placed, so the referendum's alarm should point to that block, at the
  // end of the decision period.
  expect(ongoingRefPostDecDep.alarm.unwrap()[0].toNumber()).toBe(preparePeriodWithOffset.toNumber())

  // Placing a decision deposit for a referendum should change nothing BUT the referendum's
  // 1. deposit data and
  // 2. alarm.
  referendumCmp(ongoingRefPreDecDep, ongoingRefPostDecDep, ['decisionDeposit', 'alarm'])

  /**
   * Wait for preparation period to elapse
   */

  let refPre = ongoingRefPostDecDep
  let refPost: PalletReferendaReferendumStatusConvictionVotingTally

  let iters: number
  match(chain.properties.schedulerBlockProvider)
    .with('Local', async () => {
      iters = smallTipper[1].preparePeriod.toNumber() - 2
    })
    .with('NonLocal', async () => {
      iters = (smallTipper[1].preparePeriod.toNumber() - 2) / 2
    })
    .exhaustive()

  for (let i = 0; i < iters!; i++) {
    await client.dev.newBlock()
    referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
    assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
    referendumData = referendumDataOpt.unwrap()
    expect(referendumData.isOngoing).toBe(true)
    refPost = referendumData.asOngoing

    referendumCmp(refPre, refPost, [], `Failed on iteration number ${i}.`)

    refPre = refPost
  }

  await client.dev.newBlock()

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  const refNowDeciding = referendumDataOpt.unwrap().asOngoing

  unwantedFields = /alarm|submitted|since/

  await check(refNowDeciding)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum upon start of decision period')

  const decisionPeriodStartBlock = ongoingRefPreDecDep.submitted.add(smallTipper[1].preparePeriod)

  expect(refNowDeciding.alarm.unwrap()[0].toNumber()).toBe(
    smallTipper[1].decisionPeriod.add(decisionPeriodStartBlock).toNumber(),
  )

  expect(refNowDeciding.deciding.unwrap().toJSON()).toEqual({
    since: decisionPeriodStartBlock.toNumber(),
    confirming: null,
  })

  referendumCmp(refPost!, refNowDeciding, ['alarm', 'deciding'])

  /**
   * Vote on the referendum
   */

  // Charlie's vote
  const ayeVote = 5e10

  let voteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: {
        aye: true,
        conviction: 'Locked3x',
      },
      balance: ayeVote,
    },
  })
  let voteEvents = await sendTransaction(voteTx.signAsync(devAccounts.charlie))

  await client.dev.newBlock()

  unwantedFields = /alarm|when|since|submitted/

  await checkEvents(voteEvents, 'convictionVoting')
    .redact({ removeKeys: unwantedFields, redactKeys: unwantedFields })
    .toMatchSnapshot("events for charlie's vote")

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("referendum info after charlie's vote")

  expect(referendumData.isOngoing).toBe(true)
  const ongoingRefFirstVote = referendumData.asOngoing

  // Charlie voted with 3x conviction
  votes.ayes += ayeVote * 3
  votes.support += ayeVote
  await check(ongoingRefFirstVote.tally).toMatchObject(votes)

  // Check Charlie's locked funds
  const charlieClassLocks = await client.api.query.convictionVoting.classLocksFor(devAccounts.charlie.address)
  const localCharlieClassLocks = [[smallTipper[0].toNumber(), ayeVote]]
  expect(charlieClassLocks.toJSON()).toEqual(localCharlieClassLocks)

  // , and overall account's votes
  const votingByCharlie: PalletConvictionVotingVoteVoting = await client.api.query.convictionVoting.votingFor(
    devAccounts.charlie.address,
    smallTipper[0],
  )
  assert(votingByCharlie.isCasting, "charlie's votes are cast, not delegated")
  const charlieCastVotes: PalletConvictionVotingVoteCasting = votingByCharlie.asCasting

  // The information present in the `VotingFor` storage item contains the referendum index,
  // which must be removed.
  const unwantedRefIx = new RegExp(`${referendumIndex},`)

  await check(charlieCastVotes.votes[0][1])
    .redact({ removeKeys: unwantedRefIx })
    .toMatchSnapshot("charlie's votes after casting his")
  expect(charlieCastVotes.votes.length).toBe(1)
  expect(charlieCastVotes.votes[0][0].toNumber()).toBe(referendumIndex)

  const charlieVotes = charlieCastVotes.votes[0][1].asStandard
  expect(charlieVotes.vote.conviction.isLocked3x).toBeTruthy()
  expect(charlieVotes.vote.isAye).toBeTruthy()

  let blockNumber = await getBlockNumber(client.api, chain.properties.schedulerBlockProvider)
  // After a vote, the referendum's alarm is set to the block following the one the vote tx was
  // included in.
  expect(ongoingRefFirstVote.alarm.unwrap()[0].toNumber()).toBe(blockNumber + 1)

  // Placing a vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, which at this point should still be counting down.
  referendumCmp(refNowDeciding, ongoingRefFirstVote, ['tally', 'alarm'])

  // Dave's vote

  const nayVote = 1e10

  voteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    Split: {
      aye: ayeVote,
      nay: nayVote,
    },
  })

  voteEvents = await sendTransaction(voteTx.signAsync(devAccounts.dave))

  await client.dev.newBlock()

  await checkEvents(voteEvents, 'convictionVoting')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for dave's vote")

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("referendum info after dave's vote")

  expect(referendumData.isOngoing).toBe(true)
  const ongoingRefSecondVote = referendumData.asOngoing

  votes.ayes += ayeVote / 10
  votes.nays += nayVote / 10
  votes.support += ayeVote
  await check(ongoingRefSecondVote.tally).toMatchObject(votes)

  const daveLockedFunds = await client.api.query.convictionVoting.classLocksFor(devAccounts.dave.address)
  const localDaveClassLocks = [[smallTipper[0].toNumber(), ayeVote + nayVote]]
  // Dave voted with `split`, which does not allow expression of conviction in votes.
  expect(daveLockedFunds.toJSON()).toEqual(localDaveClassLocks)

  // Check Dave's overall votes

  const votingByDave: PalletConvictionVotingVoteVoting = await client.api.query.convictionVoting.votingFor(
    devAccounts.dave.address,
    smallTipper[0],
  )
  assert(votingByDave.isCasting, "dave's votes are cast, not delegated")
  const daveCastVotes: PalletConvictionVotingVoteCasting = votingByDave.asCasting

  await check(daveCastVotes.votes[0][1])
    .redact({ removeKeys: unwantedRefIx })
    .toMatchSnapshot("dave's votes after casting his")

  expect(daveCastVotes.votes.length).toBe(1)
  expect(daveCastVotes.votes[0][0].toNumber()).toBe(referendumIndex)

  const daveVote = daveCastVotes.votes[0][1].asSplit
  expect(daveVote.aye.toNumber()).toBe(ayeVote)
  expect(daveVote.nay.toNumber()).toBe(nayVote)

  blockNumber = await getBlockNumber(client.api, chain.properties.schedulerBlockProvider)
  // After a vote, the referendum's alarm is set to the block following the one the vote tx was
  // included in.
  expect(ongoingRefSecondVote.alarm.unwrap()[0].toNumber()).toBe(blockNumber + 1)

  // Placing a split vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, still counting down.
  referendumCmp(ongoingRefFirstVote, ongoingRefSecondVote, ['tally', 'alarm'])

  // Eve's vote

  const abstainVote = 2e10

  voteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    SplitAbstain: {
      aye: ayeVote,
      nay: nayVote,
      abstain: abstainVote,
    },
  })

  voteEvents = await sendTransaction(voteTx.signAsync(devAccounts.eve))

  await client.dev.newBlock()

  await checkEvents(voteEvents, 'convictionVoting')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for eve's vote")

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData).redact({ removeKeys: unwantedFields }).toMatchSnapshot("referendum info after eve's vote")

  expect(referendumData.isOngoing).toBe(true)
  const ongoingRefThirdVote = referendumData.asOngoing

  votes.ayes += ayeVote / 10
  votes.nays += nayVote / 10
  votes.support += ayeVote + abstainVote
  await check(ongoingRefThirdVote.tally).toMatchObject(votes)

  const eveLockedFunds = await client.api.query.convictionVoting.classLocksFor(devAccounts.eve.address)
  const localEveClassLocks = [[smallTipper[0].toNumber(), ayeVote + nayVote + abstainVote]]
  // Eve voted with `splitAbstain`, which does not allow expression of conviction in votes.
  expect(eveLockedFunds.toJSON()).toEqual(localEveClassLocks)

  // Check Eve's overall votes

  const votingByEve: PalletConvictionVotingVoteVoting = await client.api.query.convictionVoting.votingFor(
    devAccounts.eve.address,
    smallTipper[0],
  )
  assert(votingByEve.isCasting, "eve's votes are cast, not delegated")
  const eveCastVotes: PalletConvictionVotingVoteCasting = votingByEve.asCasting

  await check(eveCastVotes.votes[0][1])
    .redact({ removeKeys: unwantedRefIx })
    .toMatchSnapshot("eve's votes after casting hers")
  expect(eveCastVotes.votes.length).toBe(1)
  expect(eveCastVotes.votes[0][0].toNumber()).toBe(referendumIndex)

  const eveVote = eveCastVotes.votes[0][1].asSplitAbstain
  expect(eveVote.aye.toNumber()).toBe(ayeVote)
  expect(eveVote.nay.toNumber()).toBe(nayVote)
  expect(eveVote.abstain.toNumber()).toBe(abstainVote)

  blockNumber = await getBlockNumber(client.api, chain.properties.schedulerBlockProvider)
  // As before, after another vote, the referendum's alarm is set to the block following the one the vote tx was
  // included in.
  expect(ongoingRefThirdVote.alarm.unwrap()[0].toNumber()).toBe(blockNumber + 1)

  // Placing a split abstain vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, still counting down.
  referendumCmp(ongoingRefSecondVote, ongoingRefThirdVote, ['tally', 'alarm'])

  // Attempt to cancel the referendum with a signed origin - this should fail.

  const cancelRefCall = client.api.tx.referenda.cancel(referendumIndex)
  await sendTransaction(cancelRefCall.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'cancelling referendum with signed origin',
  )

  // Cancel the referendum using the scheduler pallet to simulate a root origin

  await scheduleInlineCallWithOrigin(
    client,
    cancelRefCall.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  /**
   * Check cancelled ref's data
   */

  // First, the emitted events
  // Retrieve the events for the latest block
  const events = await client.api.query.system.events()

  const referendaEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'referenda'
  })

  expect(referendaEvents.length).toBe(1)

  const cancellationEvent = referendaEvents[0]
  assert(client.api.events.referenda.Cancelled.is(cancellationEvent.event))

  const [index, tally] = cancellationEvent.event.data
  expect(index.toNumber()).toBe(referendumIndex)
  expect(tally.toJSON()).toEqual(votes)

  // Now, check the referendum's data, post-cancellation

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  // cancelling a referendum does not remove it from storage
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")

  expect(referendumDataOpt.unwrap().isCancelled).toBeTruthy()
  const cancelledRef: ITuple<[u32, Option<PalletReferendaDeposit>, Option<PalletReferendaDeposit>]> =
    referendumDataOpt.unwrap().asCancelled

  blockNumber = await getBlockNumber(client.api, chain.properties.schedulerBlockProvider)
  match(chain.properties.schedulerBlockProvider)
    .with('Local', async () => {
      expect(cancelledRef[0].toNumber()).toBe(blockNumber)
    })
    .with('NonLocal', async () => {
      expect(cancelledRef[0].toNumber()).toBe(blockNumber - 2)
    })
  // Check that the referendum's submission deposit was refunded to Alice
  expect(cancelledRef[1].unwrap().toJSON()).toEqual({
    who: encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding),
    amount: client.api.consts.referenda.submissionDeposit.toNumber(),
  })
  // Check that the referendum's submission deposit was refunded to Bob
  expect(cancelledRef[2].unwrap().toJSON()).toEqual({
    who: encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding),
    amount: smallTipper[1].decisionDeposit.toNumber(),
  })

  const testAccounts = {
    charlie: {
      classLocks: charlieClassLocks,
      localClassLocks: localCharlieClassLocks,
      votingBy: votingByCharlie,
    },
    dave: {
      classLocks: daveLockedFunds,
      localClassLocks: localDaveClassLocks,
      votingBy: votingByDave,
    },
    eve: {
      classLocks: eveLockedFunds,
      localClassLocks: localEveClassLocks,
      votingBy: votingByEve,
    },
  }

  // Check that cancelling the referendum has no effect on each voter's class locks
  for (const account of Object.keys(testAccounts) as (keyof typeof testAccounts)[]) {
    testAccounts[account].classLocks = await client.api.query.convictionVoting.classLocksFor(
      devAccounts[account].address,
    )
    expect(
      testAccounts[account].classLocks.toJSON(),
      `${account}'s class locks should be unaffected by referendum cancellation`,
    ).toEqual(testAccounts[account].localClassLocks)
  }

  // Check that cancelling the referendum has no effect on accounts' votes, as seen via `votingFor`
  // storage item.
  for (const account of Object.keys(testAccounts) as (keyof typeof testAccounts)[]) {
    const postCancellationVoting: PalletConvictionVotingVoteVoting = await client.api.query.convictionVoting.votingFor(
      devAccounts[account].address as string,
      smallTipper[0],
    )
    assert(postCancellationVoting.isCasting, `pre-referendum cancellation, ${account}'s votes were cast, not delegated`)
    const postCancellationCastVotes: PalletConvictionVotingVoteCasting = postCancellationVoting.asCasting
    expectPjsEqual(
      postCancellationVoting,
      testAccounts[account].votingBy,
      `${account}'s votes should be unaffected by referendum cancellation`,
    )
    await check(postCancellationCastVotes.votes[0][1])
      .redact({ removeKeys: unwantedRefIx })
      .toMatchSnapshot(`${account}'s votes after referendum's cancellation`)
  }

  /**
   * Vote withdrawal transactions, batched atomically.
   */

  const removeCharlieVote = client.api.tx.convictionVoting.removeVote(smallTipper[0], referendumIndex).method
  const removeDaveVoteAsCharlie = client.api.tx.convictionVoting.removeOtherVote(
    devAccounts.dave.address,
    smallTipper[0],
    referendumIndex,
  ).method
  const removeEveVoteAsCharlie = client.api.tx.convictionVoting.removeOtherVote(
    devAccounts.eve.address,
    smallTipper[0],
    referendumIndex,
  ).method

  const batchAllTx = client.api.tx.utility.batchAll([
    removeCharlieVote,
    removeDaveVoteAsCharlie,
    removeEveVoteAsCharlie,
  ])

  const batchEvents = await sendTransaction(batchAllTx.signAsync(devAccounts.charlie))

  await client.dev.newBlock()

  await checkEvents(batchEvents)
    .redact({ removeKeys: /who/ })
    .toMatchSnapshot('removal of votes in cancelled referendum')

  // Check that each voter's class locks remain unaffected by vote removal - these are subject to a
  // later update.
  //
  // Also check that voting for each account is appropriately empty.
  for (const account of Object.keys(testAccounts) as (keyof typeof testAccounts)[]) {
    testAccounts[account].classLocks = await client.api.query.convictionVoting.classLocksFor(
      devAccounts[account].address,
    )
    expect(
      testAccounts[account].classLocks.toJSON(),
      `${account}'s class locks should be unaffected by vote removal`,
    ).toEqual(testAccounts[account].localClassLocks)
    await check(testAccounts[account].classLocks).toMatchSnapshot(
      `${account}'s class locks after their vote's rescission`,
    )

    testAccounts[account].votingBy = await client.api.query.convictionVoting.votingFor(
      devAccounts[account].address,
      smallTipper[0],
    )
    assert(testAccounts[account].votingBy.isCasting)
    const castVotes = testAccounts[account].votingBy.asCasting
    await check(castVotes).toMatchSnapshot(`${account}'s votes after rescission`)
    expect(castVotes.votes.isEmpty).toBeTruthy()
  }

  // Check that submission and decision deposits are refunded to the respective voters.

  const submissionRefundTx = client.api.tx.referenda.refundSubmissionDeposit(referendumIndex)
  const submissionRefundEvents = await sendTransaction(submissionRefundTx.signAsync(devAccounts.alice))
  const decisionRefundTx = client.api.tx.referenda.refundDecisionDeposit(referendumIndex)
  const decisionRefundEvents = await sendTransaction(decisionRefundTx.signAsync(devAccounts.bob))

  await client.dev.newBlock()

  await checkEvents(submissionRefundEvents, 'referenda')
    .redact({ removeKeys: /index/ })
    .toMatchSnapshot('refund of submission deposit')

  await checkEvents(decisionRefundEvents, 'referenda')
    .redact({ removeKeys: /index/ })
    .toMatchSnapshot('refund of decision deposit')
}

/**
 * Test the process of
 * 1. submitting a referendum for a treasury spend
 * 2. placing its decision deposit
 * 3. killing the referendum using the scheduler to insert a `Root`-origin call
 *
 *     3.1 checking that submission/decision deposits are slashed
 */
export async function referendumLifecycleKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  // Fund test accounts not already provisioned in the test chain spec.
  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: 10000e10 } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  /**
   * Get current referendum count i.e. the next referendum's index
   */
  const referendumIndex = (await client.api.query.referenda.referendumCount()).toNumber()

  /**
   * Submit a new referendum
   */

  const submitReferendumTx = client.api.tx.referenda.submit(
    {
      Origins: 'SmallTipper',
    } as any,
    {
      Inline: client.api.tx.treasury.spendLocal(1e10, devAccounts.bob.address).method.toHex(),
    },
    {
      After: 1,
    },
  )
  await sendTransaction(submitReferendumTx.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  /**
   * Check the created referendum's data
   */

  const referendaTracks = client.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.toString().startsWith('small_tipper'))!

  /**
   * Place decision deposit
   */

  const decisionDepTx = client.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  await sendTransaction(decisionDepTx.signAsync(devAccounts.bob))

  await client.dev.newBlock()

  // Attempt to kill the referendum with a signed origin

  const killRefCall = client.api.tx.referenda.kill(referendumIndex)
  await sendTransaction(killRefCall.signAsync(devAccounts.alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'killing referendum with signed origin',
  )

  /**
   * Kill the referendum using the scheduler pallet to simulate a root origin for the call.
   */

  await scheduleInlineCallWithOrigin(
    client,
    killRefCall.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  /**
   * Check killed ref's data
   */

  // Retrieve the events for the latest block
  const events = await client.api.query.system.events()

  const referendaEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'referenda'
  })

  expect(referendaEvents.length, 'killing a referendum should emit 3 events').toBe(3)

  referendaEvents.forEach((record) => {
    const { event } = record
    if (client.api.events.referenda.Killed.is(event)) {
      const [index, tally] = event.data
      expect(index.toNumber()).toBe(referendumIndex)
      expect(tally.ayes.toNumber()).toBe(0)
      expect(tally.nays.toNumber()).toBe(0)
      expect(tally.support.toNumber()).toBe(0)
    } else if (client.api.events.referenda.DepositSlashed.is(event)) {
      const [who, amount] = event.data

      if (who.toString() === encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding)) {
        expect(amount.toNumber()).toBe(client.api.consts.referenda.submissionDeposit.toNumber())
      } else if (who.toString() === encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding)) {
        expect(amount.toNumber()).toBe(smallTipper[1].decisionDeposit.toNumber())
      } else {
        expect.fail('malformed decision slashed events')
      }
    }
  })

  const referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  // killing a referendum does not remove it from storage, though it does prune most of its data.
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  expect(referendumDataOpt.unwrap().isKilled, 'referendum should be killed!').toBeTruthy()

  // The only information left from the killed referendum is the block number when it was killed.
  const blockNumber = await getBlockNumber(client.api, chain.properties.schedulerBlockProvider)
  const killedRef: u32 = referendumDataOpt.unwrap().asKilled
  match(chain.properties.schedulerBlockProvider)
    .with('Local', async () => {
      expect(killedRef.toNumber()).toBe(blockNumber)
    })
    .with('NonLocal', async () => {
      expect(killedRef.toNumber()).toBe(blockNumber - 2)
    })
}

/**
 * Shared preamble for negative-outcome tests:
 * 1. submitting a referendum on the given track
 * 2. placing its decision deposit
 * 3. reading back the created referendum's data
 */
async function submitAndDeposit(
  client: Awaited<ReturnType<typeof setupNetworks>>[0],
  trackConfig: GovernanceTrackConfig,
) {
  const referendaTracks = client.api.consts.referenda.tracks
  const track = referendaTracks.find((t) => t[0].toNumber() === trackConfig.trackId)
  assert(track, `Track '${trackConfig.trackName}' (ID ${trackConfig.trackId}) not found in runtime`)

  /**
   * 1. Submit a new referendum on the given track
   */

  const referendumIndex = (await client.api.query.referenda.referendumCount()).toNumber()

  const submissionTx = client.api.tx.referenda.submit(
    { Origins: trackConfig.originName } as any,
    { Inline: client.api.tx.system.remark('hello').method.toHex() },
    { After: 1 },
  )
  await sendTransaction(submissionTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  /**
   * 2. Place decision deposit
   */

  const decisionDepTx = client.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  await sendTransaction(decisionDepTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  /**
   * 3. Check the created referendum's data
   */

  const referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None` after submission + deposit")
  const referendumData = referendumDataOpt.unwrap()
  assert(referendumData.isOngoing)

  return { referendumIndex, ongoing: referendumData.asOngoing, track }
}

/**
 * Fast-forward a referendum to the end of its decision period via storage injection:
 * 1. backdating `submitted` and `deciding.since` so the decision period has elapsed by the next block
 * 2. scheduling a `nudgeReferendum` call via the scheduler
 */
async function injectDecisionPeriodEnd(
  client: Awaited<ReturnType<typeof setupNetworks>>[0],
  chain: Chain<any, any>,
  referendumIndex: number,
  ongoing: PalletReferendaReferendumStatusConvictionVotingTally,
  track: (typeof client.api.consts.referenda.tracks)[number],
) {
  const currentBlock = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const decisionPeriod = track[1].decisionPeriod.toNumber()
  const prepPeriod = track[1].preparePeriod.toNumber()

  /**
   * 1. Backdate the referendum so the decision period has elapsed by the next block
   *
   * Runtime rejects when: now >= deciding.since + decisionPeriod
   * Next block's local number: currentBlock + 1
   */

  const decidingSince = currentBlock + 1 - decisionPeriod
  const newSubmitted = decidingSince - prepPeriod

  await client.dev.setStorage({
    Referenda: {
      ReferendumInfoFor: [
        [
          [referendumIndex],
          {
            Ongoing: {
              track: ongoing.track,
              origin: ongoing.origin,
              proposal: ongoing.proposal,
              enactment: ongoing.enactment,
              submitted: newSubmitted,
              submissionDeposit: ongoing.submissionDeposit,
              decisionDeposit: ongoing.decisionDeposit,
              deciding: { since: decidingSince, confirming: null },
              tally: ongoing.tally,
              inQueue: ongoing.inQueue,
              alarm: [currentBlock + 1, [currentBlock + 1, 0]],
            },
          },
        ],
      ],
    },
  })

  /**
   * 2. Schedule a nudge for the next block so the runtime evaluates the referendum
   */

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.nudgeReferendum(referendumIndex).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
}

/**
 * Post-rejection verification:
 * 1. checking that the `Rejected` event was emitted
 * 2. checking the rejected referendum's data
 * 3. refunding the decision deposit (should succeed)
 * 4. attempting to refund the submission deposit (should fail with `BadStatus`)
 */
async function verifyRejection(
  client: Awaited<ReturnType<typeof setupNetworks>>[0],
  referendumIndex: number,
  trackLabel: string,
  scenarioLabel: string,
) {
  /**
   * 1. Check the `Rejected` event
   */

  const events = await client.api.query.system.events()
  const referendaEvents = events.filter(({ event }) => event.section === 'referenda')

  expect(referendaEvents.length, 'rejecting a referendum should emit 1 referenda event').toBe(1)
  const rejectedEvent = referendaEvents[0]
  expect(client.api.events.referenda.Rejected.is(rejectedEvent.event)).toBe(true)

  await check(rejectedEvent)
    .redact({ removeKeys: /index|pollIndex/ })
    .toMatchSnapshot(`rejected referendum event (${scenarioLabel}) - ${trackLabel}`)

  /**
   * 2. Check the rejected referendum's data
   */

  const referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome)
  const referendumData = referendumDataOpt.unwrap()
  expect(referendumData.isRejected).toBe(true)

  const rejectedRef: ITuple<[u32, Option<PalletReferendaDeposit>, Option<PalletReferendaDeposit>]> =
    referendumData.asRejected
  expect(rejectedRef[1].isSome, 'submission deposit should be present after rejection').toBe(true)
  expect(rejectedRef[2].isSome, 'decision deposit should be present after rejection').toBe(true)

  /**
   * 3. Refund the decision deposit — this should succeed for rejected referenda
   */

  const refundDecisionTx = client.api.tx.referenda.refundDecisionDeposit(referendumIndex)
  await sendTransaction(refundDecisionTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'referenda', method: 'DecisionDepositRefunded' })
    .redact({ removeKeys: /index/ })
    .toMatchSnapshot(`decision deposit refund after rejection (${scenarioLabel}) - ${trackLabel}`)

  /**
   * 4. Attempt to refund the submission deposit — this should fail with `BadStatus`
   */

  const refundSubmissionTx = client.api.tx.referenda.refundSubmissionDeposit(referendumIndex)
  await sendTransaction(refundSubmissionTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  const postRefundEvents = await client.api.query.system.events()
  const failedRefundEvent = postRefundEvents.find(
    ({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed',
  )
  assert(failedRefundEvent, 'submission deposit refund should have failed for rejected referendum')
  assert(client.api.events.system.ExtrinsicFailed.is(failedRefundEvent.event))
  const dispatchError = failedRefundEvent.event.data.dispatchError
  assert(dispatchError.isModule)
  expect(client.api.errors.referenda.BadStatus.is(dispatchError.asModule)).toBe(true)
}

/**
 * Test the rejection of a referendum due to insufficient support:
 * 1. submitting a referendum and placing its decision deposit
 * 2. casting a single nay vote (approval = 0 %, support = 0 %)
 * 3. fast-forwarding the decision period via storage injection
 * 4. verifying the runtime organically rejects the referendum
 *
 *     4.1 checking the `Rejected` event and referendum storage state
 *
 *     4.2 checking that the decision deposit can be refunded
 *
 *     4.3 checking that the submission deposit cannot be refunded (`BadStatus`)
 */
export async function insufficientSupportTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, trackConfig: GovernanceTrackConfig) {
  const [client] = await setupNetworks(chain)

  const referendaTracks = client.api.consts.referenda.tracks
  const track = referendaTracks.find((t) => t[0].toNumber() === trackConfig.trackId)!
  const decisionDeposit = track[1].decisionDeposit.toBigInt()
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()

  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: (submissionDeposit * 10n).toString() } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: (decisionDeposit * 10n).toString() } }],
        [[devAccounts.charlie.address], { providers: 1, data: { free: 10e10 } }],
      ],
    },
  })

  /**
   * 1. Submit referendum and place decision deposit
   */

  const { referendumIndex } = await submitAndDeposit(client, trackConfig)

  /**
   * 2. Cast a single nay vote
   *
   * A nay vote is required: an empty tally (0/0/0) passes approval because
   * `Perbill::from_rational(0, 0)` returns 100 % in Substrate.
   *
   * With only a nay: approval = 0 %, support = 0 %.
   */

  const nayBalance = 1e10
  const nayVoteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: { aye: false, conviction: 'None' },
      balance: nayBalance,
    },
  })
  await sendTransaction(nayVoteTx.signAsync(devAccounts.charlie))
  await client.dev.newBlock()

  const postVoteOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(postVoteOpt.isSome)
  const postVote = postVoteOpt.unwrap()
  assert(postVote.isOngoing)
  const ongoingPostVote = postVote.asOngoing

  expect(ongoingPostVote.tally.ayes.toBigInt()).toBe(0n)
  expect(ongoingPostVote.tally.support.toBigInt()).toBe(0n)
  expect(ongoingPostVote.tally.nays.toBigInt() > 0n).toBe(true)

  /**
   * 3. Fast-forward past the decision period and nudge
   */

  await injectDecisionPeriodEnd(client, chain, referendumIndex, ongoingPostVote, track)
  await client.dev.newBlock()

  /**
   * 4. Verify the referendum was rejected
   *
   *     4.1 checking the `Rejected` event and referendum storage state
   *
   *     4.2 checking that the decision deposit can be refunded
   *
   *     4.3 checking that the submission deposit cannot be refunded (`BadStatus`)
   */

  await verifyRejection(client, referendumIndex, trackConfig.trackName, 'insufficient support')
}

/**
 * Test the rejection of a referendum due to insufficient approval:
 * 1. submitting a referendum and placing its decision deposit
 * 2. casting an aye vote large enough to clear support (10 % of total issuance)
 * 3. casting a nay vote that sinks approval below the 50 % floor (3× the aye)
 * 4. checking the tally
 * 5. fast-forwarding the decision period via storage injection
 * 6. verifying the runtime organically rejects the referendum
 *
 *     6.1 checking the `Rejected` event and referendum storage state
 *
 *     6.2 checking that the decision deposit can be refunded
 *
 *     6.3 checking that the submission deposit cannot be refunded (`BadStatus`)
 */
export async function insufficientApprovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, trackConfig: GovernanceTrackConfig) {
  const [client] = await setupNetworks(chain)

  const referendaTracks = client.api.consts.referenda.tracks
  const track = referendaTracks.find((t) => t[0].toNumber() === trackConfig.trackId)!
  const decisionDeposit = track[1].decisionDeposit.toBigInt()
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()

  const totalIssuance = (await client.api.query.balances.totalIssuance()).toBigInt()

  // aye = 10 % of total issuance (clears support), nay = 3× aye (approval = 25 % < 50 % floor)
  const ayeBalance = totalIssuance / 10n
  const nayBalance = ayeBalance * 3n

  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: (submissionDeposit * 10n).toString() } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: (decisionDeposit * 10n).toString() } }],
        [[devAccounts.charlie.address], { providers: 1, data: { free: (ayeBalance * 2n).toString() } }],
        [[devAccounts.dave.address], { providers: 1, data: { free: (nayBalance * 2n).toString() } }],
      ],
    },
  })

  /**
   * 1. Submit referendum and place decision deposit
   */

  const { referendumIndex } = await submitAndDeposit(client, trackConfig)

  /**
   * 2. Cast an aye vote large enough to clear support
   */

  const ayeVoteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: { aye: true, conviction: 'Locked1x' },
      balance: ayeBalance.toString(),
    },
  })
  await sendTransaction(ayeVoteTx.signAsync(devAccounts.charlie))
  await client.dev.newBlock()

  /**
   * 3. Cast a nay vote that sinks approval below the 50 % floor
   */

  const nayVoteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: { aye: false, conviction: 'Locked1x' },
      balance: nayBalance.toString(),
    },
  })
  await sendTransaction(nayVoteTx.signAsync(devAccounts.dave))
  await client.dev.newBlock()

  /**
   * 4. Check the tally
   */

  const postVoteOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(postVoteOpt.isSome)
  const postVote = postVoteOpt.unwrap()
  assert(postVote.isOngoing)
  const ongoingPostVote = postVote.asOngoing

  expect(ongoingPostVote.tally.ayes.toBigInt()).toBe(ayeBalance)
  expect(ongoingPostVote.tally.nays.toBigInt()).toBe(nayBalance)
  expect(ongoingPostVote.tally.support.toBigInt()).toBe(ayeBalance)

  /**
   * 5. Fast-forward past the decision period and nudge
   */

  await injectDecisionPeriodEnd(client, chain, referendumIndex, ongoingPostVote, track)
  await client.dev.newBlock()

  /**
   * 6. Verify the referendum was rejected
   *
   *     6.1 checking the `Rejected` event and referendum storage state
   *
   *     6.2 checking that the decision deposit can be refunded
   *
   *     6.3 checking that the submission deposit cannot be refunded (`BadStatus`)
   */

  await verifyRejection(client, referendumIndex, trackConfig.trackName, 'insufficient approval')
}

/// -------
/// Test trees
/// -------

function insufficientSupportTestTree<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, tracks: GovernanceTrackConfig[]): DescribeNode {
  const children: TestNode[] = tracks.map((trackConfig) => ({
    kind: 'test' as const,
    label: `insufficient support rejection for ${trackConfig.trackName}`,
    testFn: async () => await insufficientSupportTest(chain, trackConfig),
  }))

  return {
    kind: 'describe',
    label: 'insufficient support rejection tests',
    children,
  }
}

function insufficientApprovalTestTree<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, tracks: GovernanceTrackConfig[]): DescribeNode {
  const children: TestNode[] = tracks.map((trackConfig) => ({
    kind: 'test' as const,
    label: `insufficient approval rejection for ${trackConfig.trackName}`,
    testFn: async () => await insufficientApprovalTest(chain, trackConfig),
  }))

  return {
    kind: 'describe',
    label: 'insufficient approval rejection tests',
    children,
  }
}

export function baseGovernanceE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, govConfig: GovernanceTestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: govConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: 'referenda tests',
        children: [
          {
            kind: 'test',
            label: 'referendum submission and timeout',
            testFn: async () => await submitReferendumTest(chain),
          },
          {
            kind: 'test',
            label: 'referendum lifecycle test - submission, decision deposit, various voting should all work',
            testFn: async () => await referendumLifecycleTest(chain),
          },
          {
            kind: 'test',
            label: 'referendum lifecycle test 2 - submission, decision deposit, and killing should work',
            testFn: async () => await referendumLifecycleKillTest(chain),
          },
        ],
      },
      insufficientSupportTestTree(chain, govConfig.tracks),
      insufficientApprovalTestTree(chain, govConfig.tracks),
    ],
  }
}
