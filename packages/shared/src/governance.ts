import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type DescribeNode, type RootTestTree, setupNetworks } from '@e2e-test/shared'

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
  /** Must match the runtime's `Origins` enum variant (e.g. `'SmallTipper'`), or a system origin (e.g. `'Root'`). */
  originName: string
  /** When true, the proposal origin is `{ system: originName }` instead of `{ Origins: originName }`. */
  systemOrigin?: boolean
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
 * Test the rejection of a referendum due to a missing decision deposit (undeciding timeout):
 * 1. submitting a referendum (without placing a decision deposit)
 * 2. checking the created referendum's data
 * 3. fast-forwarding past the undeciding timeout via storage injection
 * 4. verifying the runtime times out the referendum
 *
 *     4.1 checking the `TimedOut` event and referendum storage state
 *
 *     4.2 checking that the submission deposit cannot be refunded (`BadStatus`)
 */
export async function missingDecisionDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, trackConfig: GovernanceTrackConfig) {
  const [client] = await setupNetworks(chain)

  const referendaTracks = client.api.consts.referenda.tracks
  const track = referendaTracks.find((t) => t[0].toNumber() === trackConfig.trackId)!
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()

  const decisionDeposit = track[1].decisionDeposit.toBigInt()
  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: (submissionDeposit * 10n).toString() } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: (decisionDeposit * 10n).toString() } }],
      ],
    },
  })

  /**
   * 1. Submit a referendum and place its decision deposit, then immediately refund it
   *
   * We go through submitAndDeposit to reliably get a referendum index (the fork block
   * may create other referenda in the same block), then undo the deposit via storage
   * to simulate the "no decision deposit" scenario.
   */

  const { referendumIndex, ongoing: ongoingWithDeposit } = await submitAndDeposit(client, trackConfig)

  await client.dev.setStorage({
    Referenda: {
      ReferendumInfoFor: [
        [
          [referendumIndex],
          {
            Ongoing: {
              track: ongoingWithDeposit.track,
              origin: ongoingWithDeposit.origin,
              proposal: ongoingWithDeposit.proposal,
              enactment: ongoingWithDeposit.enactment,
              submitted: ongoingWithDeposit.submitted,
              submissionDeposit: ongoingWithDeposit.submissionDeposit,
              decisionDeposit: null,
              deciding: null,
              tally: ongoingWithDeposit.tally,
              inQueue: false,
              alarm: ongoingWithDeposit.alarm,
            },
          },
        ],
      ],
    },
  })

  /**
   * 2. Check the referendum's data — decision deposit should be absent
   */

  let referendumDataOpt = (await client.api.query.referenda.referendumInfoFor(
    referendumIndex,
  )) as unknown as Option<PalletReferendaReferendumInfoConvictionVotingTally>
  assert(referendumDataOpt.isSome)
  let referendumData: PalletReferendaReferendumInfoConvictionVotingTally = referendumDataOpt.unwrap()
  assert(referendumData.isOngoing)
  const ongoingReferendum = referendumData.asOngoing

  expect(ongoingReferendum.track.toNumber()).toBe(track[0].toNumber())
  expect(ongoingReferendum.decisionDeposit.isNone).toBe(true)
  expect(ongoingReferendum.deciding.isNone).toBe(true)

  /**
   * 3. Fast-forward past the undeciding timeout via storage injection
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

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.nudgeReferendum(referendumIndex).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  /**
   * 4. Verify the referendum timed out
   *
   *     4.1 checking the `TimedOut` event and referendum storage state
   */

  const events = await client.api.query.system.events()
  const timedOutEvents = events.filter(
    ({ event }) => client.api.events.referenda.TimedOut.is(event) && event.data[0].toNumber() === referendumIndex,
  )
  expect(timedOutEvents.length, 'timing out a referendum should emit 1 TimedOut event').toBe(1)

  await check(timedOutEvents[0])
    .redact({ removeKeys: /index|pollIndex/, number: true })
    .toMatchSnapshot(`timed-out referendum event (missing decision deposit) - ${trackConfig.trackName}`)

  referendumDataOpt = (await client.api.query.referenda.referendumInfoFor(
    referendumIndex,
  )) as unknown as Option<PalletReferendaReferendumInfoConvictionVotingTally>
  assert(referendumDataOpt.isSome)
  referendumData = referendumDataOpt.unwrap()
  expect(referendumData.isTimedOut).toBe(true)

  // [end_block, submission_deposit, decision_deposit]
  const timedOutRef: ITuple<[u32, Option<PalletReferendaDeposit>, Option<PalletReferendaDeposit>]> =
    referendumData.asTimedOut
  expect(timedOutRef[1].isSome, 'submission deposit should be present after timeout').toBe(true)
  expect(timedOutRef[2].isNone, 'decision deposit should be absent (never placed)').toBe(true)

  /**
   *     4.2 checking that the submission deposit cannot be refunded (`BadStatus`)
   */

  const refundTx = client.api.tx.referenda.refundSubmissionDeposit(referendumIndex)
  await sendTransaction(refundTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  const postRefundEvents = await client.api.query.system.events()
  const failedRefundEvent = postRefundEvents.find(
    ({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed',
  )
  assert(failedRefundEvent, 'submission deposit refund should have failed for timed-out referendum')
  assert(client.api.events.system.ExtrinsicFailed.is(failedRefundEvent.event))
  const dispatchError = failedRefundEvent.event.data.dispatchError
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

  unwantedFields = /alarm|when|since|submitted|pollIndex/

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
  const charlieAccount = await client.api.query.system.account(devAccounts.charlie.address)
  expect(charlieAccount.data.frozen.toNumber()).toBe(ayeVote)

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
  const daveAccount = await client.api.query.system.account(devAccounts.dave.address)
  expect(daveAccount.data.frozen.toNumber()).toBe(ayeVote + nayVote)

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
  const eveAccount = await client.api.query.system.account(devAccounts.eve.address)
  expect(eveAccount.data.frozen.toNumber()).toBe(ayeVote + nayVote + abstainVote)

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

  const referendaTracks = client.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.toString().startsWith('small_tipper'))!

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

  // Find referendum index from the block's Submitted events, matching our track.
  const submitEvents = await client.api.query.system.events()
  const submittedOnTrack = submitEvents.filter(
    ({ event }) =>
      client.api.events.referenda.Submitted.is(event) && event.data[1].toNumber() === smallTipper[0].toNumber(),
  )
  assert(
    submittedOnTrack.length === 1,
    `expected 1 Submitted event on small_tipper track, got ${submittedOnTrack.length}`,
  )
  assert(client.api.events.referenda.Submitted.is(submittedOnTrack[0].event))
  const referendumIndex = submittedOnTrack[0].event.data[0].toNumber()

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

  const referendumDataOpt = (await client.api.query.referenda.referendumInfoFor(referendumIndex)) as any
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
 * 2. finding the created referendum's index from the block events
 * 3. placing its decision deposit
 * 4. reading back the created referendum's data
 *
 * The referendum index is obtained by scanning the `Submitted` event rather than
 * pre-reading `referendumCount`, because scheduled calls from the fork block can
 * create other referenda in the same `newBlock()` call.
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

  const proposalOrigin = trackConfig.systemOrigin
    ? { system: trackConfig.originName }
    : { Origins: trackConfig.originName }

  const submissionTx = client.api.tx.referenda.submit(
    proposalOrigin as any,
    { Inline: client.api.tx.system.remark('hello').method.toHex() },
    { After: 1 },
  )
  await sendTransaction(submissionTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  /**
   * 2. Find the referendum index from the block events
   *
   * The fork block may schedule calls that create other referenda in the same block as
   * our submission. We identify ours by matching the track ID in the `Submitted` event.
   */

  const submitBlockEvents = await client.api.query.system.events()
  const submittedOnTrack = submitBlockEvents.filter(
    ({ event }) => client.api.events.referenda.Submitted.is(event) && event.data[1].toNumber() === trackConfig.trackId,
  )
  assert(
    submittedOnTrack.length === 1,
    `expected exactly 1 Submitted event on track ${trackConfig.trackName} (ID ${trackConfig.trackId}), got ${submittedOnTrack.length}`,
  )
  assert(client.api.events.referenda.Submitted.is(submittedOnTrack[0].event))
  const referendumIndex = submittedOnTrack[0].event.data[0].toNumber()

  /**
   * 3. Place decision deposit
   */

  const decisionDepTx = client.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  await sendTransaction(decisionDepTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  /**
   * 4. Read back the created referendum's data
   */

  const referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    (await client.api.query.referenda.referendumInfoFor(referendumIndex)) as any
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
  expectedTally: { ayes: bigint; nays: bigint; support: bigint },
) {
  /**
   * 1. Check the `Rejected` event
   */

  const events = await client.api.query.system.events()
  const referendaEvents = events.filter(({ event }) => event.section === 'referenda')

  expect(referendaEvents.length, 'rejecting a referendum should emit 1 referenda event').toBe(1)
  const rejectedEvent = referendaEvents[0]
  assert(client.api.events.referenda.Rejected.is(rejectedEvent.event))
  const [index, tally] = rejectedEvent.event.data
  expect(index.toNumber(), 'Rejected event should reference the correct referendum').toBe(referendumIndex)
  expect(tally.ayes.toBigInt()).toBe(expectedTally.ayes)
  expect(tally.nays.toBigInt()).toBe(expectedTally.nays)
  expect(tally.support.toBigInt()).toBe(expectedTally.support)

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
    (await client.api.query.referenda.referendumInfoFor(referendumIndex)) as any
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

  await verifyRejection(client, referendumIndex, trackConfig.trackName, 'insufficient support', {
    ayes: ongoingPostVote.tally.ayes.toBigInt(),
    nays: ongoingPostVote.tally.nays.toBigInt(),
    support: ongoingPostVote.tally.support.toBigInt(),
  })
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
    (await client.api.query.referenda.referendumInfoFor(referendumIndex)) as any
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

  await verifyRejection(client, referendumIndex, trackConfig.trackName, 'insufficient approval', {
    ayes: ayeBalance,
    nays: nayBalance,
    support: ayeBalance,
  })
}

/**
 * Shared preamble for track capacity overflow tests:
 * 1. submitting a blocker referendum and placing its decision deposit
 * 2. submitting the overflow referendum and placing its decision deposit
 * 3. backdating the overflow past its preparation period and nudging it into the queue
 * 4. verifying the overflow is queued
 *
 * Returns everything needed for the caller to free the blocker's slot and verify promotion.
 */
async function setupOverflow(chain: Chain<any, any>, trackConfig: GovernanceTrackConfig) {
  const [client] = await setupNetworks(chain)

  const referendaTracks = client.api.consts.referenda.tracks
  const track = referendaTracks.find((t) => t[0].toNumber() === trackConfig.trackId)!
  const decisionDeposit = track[1].decisionDeposit.toBigInt()
  const submissionDeposit = client.api.consts.referenda.submissionDeposit.toBigInt()
  const maxDeciding = track[1].maxDeciding.toNumber()
  const prepPeriod = track[1].preparePeriod.toNumber()
  const confirmPeriod = track[1].confirmPeriod.toNumber()

  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: (submissionDeposit * 10n).toString() } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: (decisionDeposit * 10n).toString() } }],
      ],
    },
  })

  /**
   * 1. Submit a blocker referendum and place its decision deposit
   */

  const { referendumIndex: blockerIndex, ongoing: blockerOngoing } = await submitAndDeposit(client, trackConfig)

  /**
   * 2. Submit the overflow referendum and place its decision deposit
   */

  const { referendumIndex: overflowIndex, ongoing: overflowOngoing } = await submitAndDeposit(client, trackConfig)

  const depositEvents = await client.api.query.system.events()
  const depositPlaced = depositEvents.find(
    ({ event }) =>
      client.api.events.referenda.DecisionDepositPlaced.is(event) && event.data[0].toNumber() === overflowIndex,
  )
  assert(depositPlaced, 'DecisionDepositPlaced event should be emitted for the overflow referendum')
  assert(client.api.events.referenda.DecisionDepositPlaced.is(depositPlaced.event))
  expect(depositPlaced.event.data[0].toNumber()).toBe(overflowIndex)
  expect(depositPlaced.event.data[2].toBigInt()).toBe(decisionDeposit)

  /**
   * 3. Backdate the overflow past its preparation period and nudge it into the queue
   *
   * Setting `DecidingCount` to `maxDeciding` makes the runtime believe the track is full.
   * Backdating `submitted` past the preparation period and nudging causes the runtime to
   * evaluate the overflow: because the track is full, it queues it.
   */

  const block1 = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const overflowSubmitted = block1 + 1 - prepPeriod

  await client.dev.setStorage({
    Referenda: {
      DecidingCount: [[[trackConfig.trackId], maxDeciding]],
      ReferendumInfoFor: [
        [
          [overflowIndex],
          {
            Ongoing: {
              track: overflowOngoing.track,
              origin: overflowOngoing.origin,
              proposal: overflowOngoing.proposal,
              enactment: overflowOngoing.enactment,
              submitted: overflowSubmitted,
              submissionDeposit: overflowOngoing.submissionDeposit,
              decisionDeposit: overflowOngoing.decisionDeposit,
              deciding: null,
              tally: overflowOngoing.tally,
              inQueue: false,
              alarm: [block1 + 1, [block1 + 1, 0]],
            },
          },
        ],
      ],
    },
  })

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.nudgeReferendum(overflowIndex).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  /**
   * 4. Verify the overflow is queued, not deciding
   */

  const queuedOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    (await client.api.query.referenda.referendumInfoFor(overflowIndex)) as any
  assert(queuedOpt.isSome)
  const queued = queuedOpt.unwrap()
  assert(queued.isOngoing, 'overflow referendum should still be ongoing (queued, not terminal)')
  expect(queued.asOngoing.inQueue.isTrue, 'overflow should be queued when track is at capacity').toBe(true)
  expect(queued.asOngoing.deciding.isNone, 'queued overflow should not be in decision phase').toBe(true)

  return {
    client,
    chain,
    track,
    trackConfig,
    blockerIndex,
    blockerOngoing,
    overflowIndex,
    maxDeciding,
    prepPeriod,
    confirmPeriod,
  }
}

/**
 * Post-promotion verification shared across overflow test variants:
 * checks the overflow left the queue, entered deciding, and emitted `DecisionStarted`.
 */
async function verifyPromotion(
  client: Awaited<ReturnType<typeof setupNetworks>>[0],
  overflowIndex: number,
  trackConfig: GovernanceTrackConfig,
  maxDeciding: number,
) {
  const promotedOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    (await client.api.query.referenda.referendumInfoFor(overflowIndex)) as any
  assert(promotedOpt.isSome)
  const promoted = promotedOpt.unwrap()
  assert(promoted.isOngoing, 'overflow should still be ongoing after promotion')
  expect(promoted.asOngoing.deciding.isSome, 'overflow should now be in decision phase').toBe(true)
  expect(promoted.asOngoing.inQueue.isFalse, 'overflow should no longer be queued').toBe(true)

  const decidingCount = ((await client.api.query.referenda.decidingCount(trackConfig.trackId)) as any).toNumber()
  expect(decidingCount, 'DecidingCount should reflect the promoted overflow').toBe(maxDeciding)

  const promotionEvents = await client.api.query.system.events()
  const decisionStarted = promotionEvents.find(
    ({ event }) => client.api.events.referenda.DecisionStarted.is(event) && event.data[0].toNumber() === overflowIndex,
  )
  assert(decisionStarted, 'DecisionStarted event should be emitted when the overflow is promoted')
  assert(client.api.events.referenda.DecisionStarted.is(decisionStarted.event))
  expect(decisionStarted.event.data[0].toNumber()).toBe(overflowIndex)
  expect(decisionStarted.event.data[1].toNumber()).toBe(trackConfig.trackId)
}

/**
 * Test that the overflow referendum is promoted after the blocker is approved:
 * 1–4. shared setup (submit both refs, queue the overflow)
 * 5. advancing the blocker to the last block of its confirmation period
 * 6. verifying the blocker passes and the overflow is promoted to deciding
 */
export async function overflowPromotionViaApprovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, trackConfig: GovernanceTrackConfig) {
  const ctx = await setupOverflow(chain, trackConfig)
  const { client, blockerIndex, blockerOngoing, overflowIndex, maxDeciding, prepPeriod, confirmPeriod } = ctx

  /**
   * 5. Advance the blocker to the last block of its confirmation period
   *
   * Setting `confirming` to `block + 1` places the blocker at the exact block where
   * confirmation ends. The injected tally has full approval and support so `is_passing`
   * holds. The blocker's nudge is written directly into the scheduler agenda alongside
   * the referendum state to avoid a second `scheduleInlineCallWithOrigin` call.
   */

  const block = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const totalIssuance = (await client.api.query.balances.totalIssuance()).toBigInt()

  const confirmDeadline = block + 1
  const decidingSince = confirmDeadline - confirmPeriod
  const blockerSubmitted = decidingSince - prepPeriod

  const schedulerBlock =
    chain.properties.schedulerBlockProvider === 'NonLocal'
      ? ((await client.api.query.parachainSystem.lastRelayChainBlockNumber()) as any).toNumber()
      : block + 1

  await client.dev.setStorage({
    Referenda: {
      ReferendumInfoFor: [
        [
          [blockerIndex],
          {
            Ongoing: {
              track: blockerOngoing.track,
              origin: blockerOngoing.origin,
              proposal: blockerOngoing.proposal,
              enactment: blockerOngoing.enactment,
              submitted: blockerSubmitted,
              submissionDeposit: blockerOngoing.submissionDeposit,
              decisionDeposit: blockerOngoing.decisionDeposit,
              deciding: { since: decidingSince, confirming: confirmDeadline },
              tally: { ayes: totalIssuance.toString(), nays: 0, support: totalIssuance.toString() },
              inQueue: false,
              alarm: [block + 1, [block + 1, 0]],
            },
          },
        ],
      ],
    },
    Scheduler: {
      agenda: [
        [
          [schedulerBlock],
          [
            {
              call: { Inline: client.api.tx.referenda.nudgeReferendum(blockerIndex).method.toHex() },
              origin: { system: 'Root' },
            },
          ],
        ],
      ],
      incompleteSince: schedulerBlock,
    },
  })

  await client.dev.newBlock()

  const blockerResultOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    (await client.api.query.referenda.referendumInfoFor(blockerIndex)) as any
  assert(blockerResultOpt.isSome)
  expect(blockerResultOpt.unwrap().isApproved, 'blocker should have been approved').toBe(true)

  /**
   * 6. Verify the overflow was promoted
   */

  await client.dev.newBlock()
  await verifyPromotion(client, overflowIndex, trackConfig, maxDeciding)
}

/**
 * Test that the overflow referendum is promoted after the blocker is rejected:
 * 1–4. shared setup (submit both refs, queue the overflow)
 * 5. fast-forwarding the blocker past its decision period with a failing tally
 * 6. verifying the blocker is rejected and the overflow is promoted to deciding
 */
export async function overflowPromotionViaRejectionTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, trackConfig: GovernanceTrackConfig) {
  const ctx = await setupOverflow(chain, trackConfig)
  const { client, blockerIndex, blockerOngoing, overflowIndex, maxDeciding } = ctx

  /**
   * 5. Fast-forward the blocker past its decision period with a failing tally
   *
   * Backdating `deciding.since` so the decision period has elapsed by the next block.
   * A nay-only tally is injected because `Perbill::from_rational(0, 0)` returns 100 %
   * in Substrate — an empty tally would pass approval and enter confirmation instead.
   */

  const block = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const decisionPeriod = ctx.track[1].decisionPeriod.toNumber()
  const prepPeriod = ctx.track[1].preparePeriod.toNumber()
  const decidingSince = block + 1 - decisionPeriod
  const blockerSubmitted = decidingSince - prepPeriod

  await client.dev.setStorage({
    Referenda: {
      ReferendumInfoFor: [
        [
          [blockerIndex],
          {
            Ongoing: {
              track: blockerOngoing.track,
              origin: blockerOngoing.origin,
              proposal: blockerOngoing.proposal,
              enactment: blockerOngoing.enactment,
              submitted: blockerSubmitted,
              submissionDeposit: blockerOngoing.submissionDeposit,
              decisionDeposit: blockerOngoing.decisionDeposit,
              deciding: { since: decidingSince, confirming: null },
              tally: { ayes: 0, nays: 1, support: 0 },
              inQueue: false,
              alarm: [block + 1, [block + 1, 0]],
            },
          },
        ],
      ],
    },
  })

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.referenda.nudgeReferendum(blockerIndex).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  const blockerResultOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    (await client.api.query.referenda.referendumInfoFor(blockerIndex)) as any
  assert(blockerResultOpt.isSome)
  expect(blockerResultOpt.unwrap().isRejected, 'blocker should have been rejected').toBe(true)

  /**
   * 6. Verify the overflow was promoted
   */

  await client.dev.newBlock()
  await verifyPromotion(client, overflowIndex, trackConfig, maxDeciding)
}

/**
 * Test that the overflow referendum is promoted after the blocker is killed:
 * 1–4. shared setup (submit both refs, queue the overflow)
 * 5. killing the blocker with a Root-origin call via the scheduler
 * 6. verifying the blocker is killed and the overflow is promoted to deciding
 */
export async function overflowPromotionViaKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, trackConfig: GovernanceTrackConfig) {
  const ctx = await setupOverflow(chain, trackConfig)
  const { client, blockerIndex, overflowIndex, maxDeciding } = ctx

  /**
   * 5. Kill the blocker with a Root-origin call via the scheduler
   */

  const schedulerBlock =
    chain.properties.schedulerBlockProvider === 'NonLocal'
      ? ((await client.api.query.parachainSystem.lastRelayChainBlockNumber()) as any).toNumber()
      : (await client.api.rpc.chain.getHeader()).number.toNumber() + 1

  await client.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [schedulerBlock],
          [{ call: { Inline: client.api.tx.referenda.kill(blockerIndex).method.toHex() }, origin: { system: 'Root' } }],
        ],
      ],
      incompleteSince: schedulerBlock,
    },
  })

  await client.dev.newBlock()

  const blockerResultOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    (await client.api.query.referenda.referendumInfoFor(blockerIndex)) as any
  assert(blockerResultOpt.isSome)
  expect(blockerResultOpt.unwrap().isKilled, 'blocker should have been killed').toBe(true)

  /**
   * 6. Verify the overflow was promoted
   */

  await client.dev.newBlock()
  await verifyPromotion(client, overflowIndex, trackConfig, maxDeciding)
}

/// -------
/// Test trees
/// -------

function negativeFlowsForTrack(chain: Chain<any, any>, trackConfig: GovernanceTrackConfig): DescribeNode {
  return {
    kind: 'describe',
    label: trackConfig.trackName,
    children: [
      {
        kind: 'test' as const,
        label: 'missing decision deposit timeout',
        testFn: async () => await missingDecisionDepositTest(chain, trackConfig),
      },
      {
        kind: 'test' as const,
        label: 'insufficient support rejection',
        testFn: async () => await insufficientSupportTest(chain, trackConfig),
      },
      {
        kind: 'test' as const,
        label: 'insufficient approval rejection',
        testFn: async () => await insufficientApprovalTest(chain, trackConfig),
      },
      {
        kind: 'describe' as const,
        label: 'track capacity overflow',
        children: [
          {
            kind: 'test' as const,
            label: 'promotion via approval',
            testFn: async () => await overflowPromotionViaApprovalTest(chain, trackConfig),
          },
          {
            kind: 'test' as const,
            label: 'promotion via rejection',
            testFn: async () => await overflowPromotionViaRejectionTest(chain, trackConfig),
          },
          {
            kind: 'test' as const,
            label: 'promotion via kill',
            testFn: async () => await overflowPromotionViaKillTest(chain, trackConfig),
          },
        ],
      },
    ],
  }
}

/**
 * Test the process of
 * 1. delegating (Bob delegates to Charlie) on the SmallTipper track
 *
 *     1.1 asserting Bob's `votingFor` is `Delegating` state with the correct target, conviction, and balance
 *
 *     1.2 asserting Charlie's `votingFor` is `Casting` state with the correct target capital and votes
 *
 *     1.3 asserting Bob's class locks reflect the delegated amount on the SmallTipper track
 *
 *     1.4 asserting Bob's frozen funds is equal to delegation amount
 *
 * 2. casting Charlie's vote on the referendum
 *
 *     2.1 asserting the tally includes both Charlie's direct conviction-weighted vote and Bob's
 *         delegated conviction-weighted vote independently
 *
 * 3. verifying Bob cannot cast a direct vote while delegating (expects `AlreadyDelegating` error)
 *
 * 4. removing Bob's delegation while the referendum is active
 *
 *     4.1 asserting the tally is immediately reduced by Bob's delegated weight
 *
 *     4.2 asserting Bob's `votingFor` reverts to `Casting` state and `prior` is delegation amount
 *
 *     4.3 asserting Charlie's `delegations` are reduced accordingly
 *
 *     4.4 asserting Bob's delegation amount is still frozen because of conviction lock
 *
 */
export async function referendumLifecycleDelegationTest<
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
      ],
    },
  })

  // Get small tipper track info
  const referendaTracks = client.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.toString().startsWith('small_tipper'))!

  // 1. Bob delegates vote to Charlie
  const delegationAmount = 1e10
  const delegateTx = client.api.tx.convictionVoting.delegate(
    smallTipper[0],
    devAccounts.charlie.address,
    'Locked2x',
    delegationAmount,
  )

  const delegationEvent = await sendTransaction(delegateTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  const unwantedFields = /index/
  await checkEvents(delegationEvent, 'convictionVoting')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for bob's delegation to charlie")

  let subEvents = await client.api.query.system.events()
  const [delEvent] = subEvents.filter((record) => {
    const { event } = record
    return event.section === 'convictionVoting' && event.method === 'Delegated'
  })
  assert(client.api.events.convictionVoting.Delegated.is(delEvent.event))
  const delegatedEventData = delEvent.event.data
  expect(delegatedEventData[0].toString()).toBe(
    encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding),
  )
  expect(delegatedEventData[1].toString()).toBe(
    encodeAddress(devAccounts.charlie.address, chain.properties.addressEncoding),
  )

  // Assert delegation state
  // 1.1 Assert Bob's `votingFor` is `Delegating` with correct target, conviction, and balance
  let bobVoting = await client.api.query.convictionVoting.votingFor(devAccounts.bob.address, smallTipper[0])
  assert(bobVoting.isDelegating, 'bob should be delegting his vote to charlie')
  const bobDelegating = bobVoting.asDelegating
  expect(bobDelegating.target.toString()).toBe(
    encodeAddress(devAccounts.charlie.address, chain.properties.addressEncoding),
  )
  expect(bobDelegating.conviction.isLocked2x).toBeTruthy()
  expect(bobDelegating.balance.toNumber()).toBe(delegationAmount)

  // 1.2 Assert Charlie's `votingFor` is `Casting` with correct target capital and votes
  let charlieVoting = await client.api.query.convictionVoting.votingFor(devAccounts.charlie.address, smallTipper[0])
  assert(charlieVoting.isCasting, 'charlie should be casting a vote on behalf of bob')
  let charlieCasting = charlieVoting.asCasting
  expect(charlieCasting.votes.length).toBe(0)
  expect(charlieCasting.delegations.capital.toNumber()).toBe(delegationAmount)
  expect(charlieCasting.delegations.votes.toNumber()).toBe(delegationAmount * 2) // Because of 'Locked2x' conviction

  // 1.3 Assert Bob's class locks reflect the delegated amount on the SmallTipper track
  const bobClassLocks = await client.api.query.convictionVoting.classLocksFor(devAccounts.bob.address)
  expect(bobClassLocks.toJSON()).toEqual([[smallTipper[0].toNumber(), delegationAmount]])

  // 1.4 Assert Bob's account frozen balance reflects the delegated amount
  let bobAccount = await client.api.query.system.account(devAccounts.bob.address)
  expect(bobAccount.data.frozen.toNumber()).toBe(delegationAmount)

  // Submit a new referendum
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

  await sendTransaction(submissionTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const [refEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'referenda' && event.method === 'Submitted'
  })
  assert(client.api.events.referenda.Submitted.is(refEvent.event))
  const refEventData = refEvent.event.data
  const referendumIndex = refEventData[0].toNumber()

  const votes = {
    ayes: 0,
    nays: 0,
    support: 0,
  }

  let referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await client.api.query.referenda.referendumInfoFor(referendumIndex)
  let referendumData: PalletReferendaReferendumInfoConvictionVotingTally = referendumDataOpt.unwrap()
  const ongoingRefPreDecDep: PalletReferendaReferendumStatusConvictionVotingTally = referendumData.asOngoing
  await check(ongoingRefPreDecDep.tally).toMatchObject(votes)

  // Place decision deposit
  const decisionDepTx = client.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  await sendTransaction(decisionDepTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  // Advance to the start of the decision period
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
  }

  await client.dev.newBlock()

  // 2. Charlie votes
  const ayeVote = 5e10
  const voteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: {
        aye: true,
        conviction: 'Locked1x',
      },
      balance: ayeVote,
    },
  })

  await sendTransaction(voteTx.signAsync(devAccounts.charlie))
  await client.dev.newBlock()

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  referendumData = referendumDataOpt.unwrap()
  const ongoingRefFirstVote = referendumData.asOngoing

  votes.ayes += ayeVote + delegationAmount * 2 // Charlie's own vote + delegated vote from Bob with 'Locked2x' conviction
  votes.support += ayeVote + delegationAmount

  // 2.1 Assert referendum tally
  await check(ongoingRefFirstVote.tally).toMatchObject(votes)

  // 3. Bob tries to cast a direct vote, should fail because he's currently delegating to Charlie
  const bobVoteTx = client.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: {
        aye: true,
        conviction: 'Locked1x',
      },
      balance: ayeVote,
    },
  })

  await sendTransaction(bobVoteTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'bob attempting to vote directly after delegating to charlie',
  )

  subEvents = await client.api.query.system.events()
  const [failEvent] = subEvents.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  assert(client.api.events.system.ExtrinsicFailed.is(failEvent.event))

  // 4. Bob removes his delegation
  const removeDelegationTx = client.api.tx.convictionVoting.undelegate(smallTipper[0])
  const undelegateEvent = await sendTransaction(removeDelegationTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  await checkEvents(undelegateEvent, 'convictionVoting')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for bob's removal of delegation to charlie")

  subEvents = await client.api.query.system.events()
  const [undelegatedEvent] = subEvents.filter((record) => {
    const { event } = record
    return event.section === 'convictionVoting' && event.method === 'Undelegated'
  })
  assert(client.api.events.convictionVoting.Undelegated.is(undelegatedEvent.event))
  const undelegatedEventData = undelegatedEvent.event.data
  expect(undelegatedEventData[0].toString()).toBe(
    encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding),
  )

  referendumDataOpt = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  referendumData = referendumDataOpt.unwrap()
  const ongoingRefPostDecDep = referendumData.asOngoing

  votes.ayes -= delegationAmount * 2
  votes.support -= delegationAmount
  // 4.1 Assert tally reduction
  await check(ongoingRefPostDecDep.tally).toMatchObject(votes)

  // 4.2 Assert Bob's `votingFor` is now `Casting` and `prior` is delegation amount
  bobVoting = await client.api.query.convictionVoting.votingFor(devAccounts.bob.address, smallTipper[0])
  assert(bobVoting.isCasting, 'bob should be casting his own vote now')
  const bobCasting = bobVoting.asCasting
  expect(bobCasting.votes.length).toBe(0)
  expect(bobCasting.delegations.capital.toNumber()).toBe(0)
  expect(bobCasting.delegations.votes.toNumber()).toBe(0)
  expect(bobCasting.prior[1].toNumber()).toBe(delegationAmount)

  // 4.3 Assert Charlie's delegations are reduced
  charlieVoting = await client.api.query.convictionVoting.votingFor(devAccounts.charlie.address, smallTipper[0])
  assert(charlieVoting.isCasting, 'charlie should be casting a vote on behalf of bob')
  charlieCasting = charlieVoting.asCasting
  expect(charlieCasting.votes.length).toBe(1)
  expect(charlieCasting.votes[0][0].toNumber()).toBe(referendumIndex)
  const charlieVote = charlieCasting.votes[0][1].asStandard
  expect(charlieVote.vote.conviction.isLocked1x).toBeTruthy()
  expect(charlieVote.vote.isAye).toBeTruthy()
  expect(charlieVote.balance.toNumber()).toBe(ayeVote)

  bobAccount = await client.api.query.system.account(devAccounts.bob.address)
  // 4.4 Amount still frozen because of conviction lock 'Locked2x' on the delegation.
  expect(bobAccount.data.frozen.toNumber()).toBe(delegationAmount)
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
            label: 'referendum lifecycle test - submission, decision deposit, various voting should all work',
            testFn: async () => await referendumLifecycleTest(chain),
          },
          {
            kind: 'test',
            label: 'referendum lifecycle test 2 - submission, decision deposit, and killing should work',
            testFn: async () => await referendumLifecycleKillTest(chain),
          },
          {
            kind: 'test',
            label:
              'referendum lifecycle test 3 - submission, decision deposit, vote delegation, vote, and delegation removal should all work',
            testFn: async () => await referendumLifecycleDelegationTest(chain),
          },
          {
            kind: 'describe',
            label: 'negative execution flows',
            children: govConfig.tracks.map((trackConfig) => negativeFlowsForTrack(chain, trackConfig)),
          },
        ],
      },
    ],
  }
}
