import { BN } from 'bn.js'
import { assert, describe, test } from 'vitest'

import { Chain, defaultAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import { check, checkEvents } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'

import {
  PalletConvictionVotingVoteCasting,
  PalletConvictionVotingVoteVoting,
  PalletReferendaDeposit,
  PalletReferendaReferendumInfoConvictionVotingTally,
  PalletReferendaReferendumStatusConvictionVotingTally,
} from '@polkadot/types/lookup'
import { ITuple } from '@polkadot/types/types'
import { Option, u32 } from '@polkadot/types'
import { encodeAddress } from '@polkadot/util-crypto'

/**
 * Compare the selected properties of two referenda.
 *
 * Fails if any of the properties to be compared is different.
 *
 * It can be desirable to compare a referendum in its pre- and post-block-execution states.
 * For example:
 * 1. from the time its decision deposited is placed until its preparation period elapses, no field
 *    of the referendum may change
 *   a. to know which block in the iterated comparisons caused the failure, an optional error
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
  errorMsg?: string,
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

  for (const prop of properties) {
    if (propertiesToBeSkipped.includes(prop)) {
      continue
    }

    const cmp = ref1[prop].eq(ref2[prop])
    if (!cmp) {
      const msg = `Referenda differed on property \`${prop}\`
        Left: ${ref1[prop]}
        Right: ${ref2[prop]}`
      let errorMessage: string
      if (errorMsg === null || errorMsg === undefined) {
        errorMessage = msg
      } else {
        errorMessage = errorMsg + '\n' + msg
      }
      assert(cmp, errorMessage)
    }
  }
}

/**
 * Test the process of
 * 1. submitting a referendum for a treasury spend
 * 2. placing its decision deposit
 * 3. awaiting the end of the preparation period
 * 4. voting on it after the decision period has commenced
 *   4.1. using `vote`
 *   4.2. using a split vote
 *   4.3. using a split-abstain vote
 * 5. cancelling the referendum using the scheduler to insert a `Root`-origin call
 *   5.1 checking that locks on submission/decision deposits are released
 *   5.2 checking that voters' class locks and voting data are not affected
 * 6. removing the votes cast
 *   6.1 asserting that voting locks are preserved
 *   6.2 asserting that voting funds are returned
 * 7. refunding the submission and decision deposits
 */
export async function referendumLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, addressEncoding: number) {
  /**
   * Setup relay and parachain clients
   */
  const [relayClient] = await setupNetworks(relayChain)

  // Fund test accounts not already provisioned in the test chain spec.
  await relayClient.dev.setStorage({
    System: {
      account: [
        [[defaultAccounts.bob.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccounts.charlie.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccounts.dave.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccounts.eve.address], { providers: 1, data: { free: 10e10 } }],
      ],
    },
  })

  /**
   * Get current referendum count i.e. the next referendum's index
   */
  const referendumIndex = await relayClient.api.query.referenda.referendumCount()

  /**
   * Submit a new referendum
   */

  const submissionTx = relayClient.api.tx.referenda.submit(
    {
      Origins: 'SmallTipper',
    } as any,
    {
      Inline: relayClient.api.tx.treasury.spendLocal(1e10, defaultAccounts.bob.address).method.toHex(),
    },
    {
      After: 1,
    },
  )
  const submissionEvents = await sendTransaction(submissionTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  // Fields to be removed, check comment below.
  let unwantedFields = new RegExp('index')
  await checkEvents(submissionEvents, 'referenda')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum submission events')

  /**
   * Check the created referendum's data
   */

  let referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "submitted referendum's data cannot be `None`")
  let referendumData: PalletReferendaReferendumInfoConvictionVotingTally = referendumDataOpt.unwrap()
  // These fields must be excised from the queried referendum data before being put in the test
  // snapshot.
  // These fields contain epoch-sensitive data, which will cause spurious test failures
  // periodically.
  unwantedFields = new RegExp('alarm|submitted')
  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum info before decision deposit')

  assert(referendumData.isOngoing)
  // Ongoing referendum data, prior to the decision deposit.
  const ongoingRefPreDecDep: PalletReferendaReferendumStatusConvictionVotingTally = referendumData.asOngoing

  assert(ongoingRefPreDecDep.alarm.isSome)
  const undecidingTimeoutAlarm = ongoingRefPreDecDep.alarm.unwrap()[0]
  const blocksUntilAlarm = undecidingTimeoutAlarm.sub(ongoingRefPreDecDep.submitted)
  // Check that the referendum's alarm is set to ring after the (globally predetermined) timeout
  // of 14 days, or 201600 blocks.
  assert(blocksUntilAlarm.eq(relayClient.api.consts.referenda.undecidingTimeout))

  // The referendum was above set to be enacted 1 block after its passing.
  assert(ongoingRefPreDecDep.enactment.isAfter)
  assert(ongoingRefPreDecDep.enactment.asAfter.eq(1))

  const referendaTracks = relayClient.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.eq('small_tipper'))!
  assert(ongoingRefPreDecDep.track.eq(smallTipper[0]))
  await check(ongoingRefPreDecDep.origin).toMatchObject({
    origins: 'SmallTipper',
  })

  // Immediately after a referendum's submission, it will not have a decision deposit,
  // which it will need to begin the decision period.
  assert(ongoingRefPreDecDep.deciding.isNone)
  assert(ongoingRefPreDecDep.decisionDeposit.isNone)

  assert(ongoingRefPreDecDep.submissionDeposit.who.eq(encodeAddress(defaultAccounts.alice.address, addressEncoding)))
  assert(ongoingRefPreDecDep.submissionDeposit.amount.eq(relayClient.api.consts.referenda.submissionDeposit))

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

  const decisionDepTx = relayClient.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  const decisiondepEvents = await sendTransaction(decisionDepTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  // Once more, fields containing temporally-contigent information - block numbers - must be excised
  // from test data to avoid spurious failures after updating block numbers.
  unwantedFields = new RegExp("alarm|index|submitted")

  await checkEvents(decisiondepEvents, 'referenda')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for bob's decision deposit")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum info post decision deposit')

  assert(referendumData.isOngoing)
  const ongoingRefPostDecDep = referendumData.asOngoing

  // The referendum can only begin deciding after its track's preparation period has elapsed, even though
  // the decision deposit has been placed.
  assert(ongoingRefPostDecDep.deciding.isNone)
  assert(ongoingRefPostDecDep.decisionDeposit.isSome)

  assert(
    ongoingRefPostDecDep.decisionDeposit.unwrap().who.eq(encodeAddress(defaultAccounts.bob.address, addressEncoding)),
  )
  assert(ongoingRefPostDecDep.decisionDeposit.unwrap().amount.eq(smallTipper[1].decisionDeposit))

  // The block at which the referendum's preparation period will end, and its decision period will begin.
  const preparePeriodWithOffset = smallTipper[1].preparePeriod.add(ongoingRefPostDecDep.submitted)

  assert(ongoingRefPostDecDep.alarm.isSome)
  // The decision deposit has been placed, so the referendum's alarm should point to that block, at the
  // end of the decision period.
  assert(ongoingRefPostDecDep.alarm.unwrap()[0].eq(preparePeriodWithOffset))

  // Placing a decision deposit for a referendum should change nothing BUT the referendum's
  // 1. deposit data and
  // 2. alarm.
  referendumCmp(ongoingRefPreDecDep, ongoingRefPostDecDep, ['decisionDeposit', 'alarm'])

  /**
   * Wait for preparation period to elapse
   */

  let refPre = ongoingRefPostDecDep
  let refPost: PalletReferendaReferendumStatusConvictionVotingTally

  for (let i = 0; i < smallTipper[1].preparePeriod.toNumber() - 2; i++) {
    await relayClient.dev.newBlock()
      referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
      assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
      referendumData = referendumDataOpt.unwrap()
      assert(referendumData.isOngoing)
      refPost = referendumData.asOngoing

      referendumCmp(refPre, refPost, [], `Failed on iteration number ${i}.`)

      refPre = refPost
  }

  await relayClient.dev.newBlock()

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  const refNowDeciding = referendumDataOpt.unwrap().asOngoing

  unwantedFields = new RegExp("alarm|submitted|since")

  await check(refNowDeciding)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum upon start of decision period')

  const decisionPeriodStartBlock = ongoingRefPreDecDep.submitted.add(smallTipper[1].preparePeriod)

  assert(refNowDeciding.alarm.unwrap()[0].eq(smallTipper[1].decisionPeriod.add(decisionPeriodStartBlock)))

  assert(refNowDeciding.deciding.eq({
    since: decisionPeriodStartBlock,
    confirming: null
  }))

  referendumCmp(refPost!, refNowDeciding, ['alarm', 'deciding'])

  /**
   * Vote on the referendum
   */

  // Charlie's vote
  const ayeVote = 5e10

  let voteTx = relayClient.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: {
        aye: true,
        conviction: 'Locked3x',
      },
      balance: ayeVote,
    },
  })
  let voteEvents = await sendTransaction(voteTx.signAsync(defaultAccounts.charlie))

  await relayClient.dev.newBlock()

  unwantedFields = new RegExp("alarm|when|since|submitted")

  // Filtering for events only from the `convictionVoting` pallet would leave them empty.
  // Voting events were only introduced in
  // https://github.com/paritytech/polkadot-sdk/pull/4613, and will take a few releases until they
  // are visible here - this will trigger a failure in tests, which can then be addressed.
  await checkEvents(voteEvents, "convictionVoting", "referenda")
    .redact({ removeKeys: unwantedFields, redactKeys: unwantedFields })
    .toMatchSnapshot("events for charlie's vote")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("referendum info after charlie's vote")

  assert(referendumData.isOngoing)
  const ongoingRefFirstVote = referendumData.asOngoing

  // Charlie voted with 3x conviction
  votes.ayes += ayeVote * 3
  votes.support += ayeVote
  await check(ongoingRefFirstVote.tally).toMatchObject(votes)

  // Check Charlie's locked funds
  const charlieClassLocks = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.charlie.address)
  const localCharlieClassLocks = [
    [
      smallTipper[0],
      ayeVote
    ]
  ]
  assert(charlieClassLocks.eq(localCharlieClassLocks))

  // , and overall account's votes
  const votingByCharlie: PalletConvictionVotingVoteVoting =
    await relayClient.api.query.convictionVoting.votingFor(defaultAccounts.charlie.address, smallTipper[0])
  assert(votingByCharlie.isCasting, "charlie's votes are cast, not delegated")
  const charlieCastVotes: PalletConvictionVotingVoteCasting = votingByCharlie.asCasting

  // The information present in the `VotingFor` storage item contains the referendum index,
  // which must be removed.
  const unwantedRefIx = new RegExp(`${referendumIndex},`)

  await check(charlieCastVotes.votes[0][1]).redact({ removeKeys: unwantedRefIx}).toMatchSnapshot("charlie's votes after casting his")
  assert(charlieCastVotes.votes.length === 1)
  assert(charlieCastVotes.votes[0][0].eq(referendumIndex))

  const charlieVotes = charlieCastVotes.votes[0][1].asStandard
  assert(charlieVotes.vote.conviction.isLocked3x && charlieVotes.vote.isAye)

  // After a vote the referendum's alarm is set to the block following the one the vote tx was
  // included in.
  ongoingRefFirstVote.alarm.unwrap()[0].eq(refNowDeciding.deciding.unwrap().since.add(new BN(1)))

  // Placing a vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, which at this point should still be counting down.
  referendumCmp(refNowDeciding, ongoingRefFirstVote, ['tally', 'alarm'])

  // Dave's vote

  const nayVote = 1e10

  voteTx = relayClient.api.tx.convictionVoting.vote(referendumIndex, {
    Split: {
      aye: ayeVote,
      nay: nayVote,
    },
  })

  voteEvents = await sendTransaction(voteTx.signAsync(defaultAccounts.dave))

  await relayClient.dev.newBlock()

  await checkEvents(voteEvents, "convictionVoting", "referenda")
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for dave's vote")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("referendum info after dave's vote")

  assert(referendumData.isOngoing)
  const ongoingRefSecondVote = referendumData.asOngoing

  votes.ayes += ayeVote / 10
  votes.nays += nayVote / 10
  votes.support += ayeVote
  await check(ongoingRefSecondVote.tally).toMatchObject(votes)

  const daveLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.dave.address)
  const localDaveClassLocks = [[smallTipper[0], ayeVote + nayVote]]
  // Dave voted with `split`, which does not allow expression of conviction in votes.
  assert(daveLockedFunds.eq(localDaveClassLocks))

  // Check Dave's overall votes

  const votingByDave: PalletConvictionVotingVoteVoting =
    await relayClient.api.query.convictionVoting.votingFor(defaultAccounts.dave.address, smallTipper[0])
  assert(votingByDave.isCasting, "dave's votes are cast, not delegated")
  const daveCastVotes: PalletConvictionVotingVoteCasting = votingByDave.asCasting

  await check(daveCastVotes.votes[0][1]).redact({ removeKeys: unwantedRefIx}).toMatchSnapshot("dave's votes after casting his")

  assert(daveCastVotes.votes.length === 1)
  assert(daveCastVotes.votes[0][0].eq(referendumIndex))

  const daveVote = daveCastVotes.votes[0][1].asSplit
  assert(daveVote.aye.eq(ayeVote))
  assert(daveVote.nay.eq(nayVote))

  // After a vote the referendum's alarm is set to the block following the one the vote tx was
  // included in.
  ongoingRefSecondVote.alarm.unwrap()[0].eq(ongoingRefFirstVote.deciding.unwrap().since.add(new BN(1)))

  // Placing a split vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, still counting down.
  referendumCmp(ongoingRefFirstVote, ongoingRefSecondVote, ['tally', 'alarm'])

  // Eve's vote

  const abstainVote = 2e10

  voteTx = relayClient.api.tx.convictionVoting.vote(referendumIndex, {
    SplitAbstain: {
      aye: ayeVote,
      nay: nayVote,
      abstain: abstainVote,
    },
  })

  voteEvents = await sendTransaction(voteTx.signAsync(defaultAccounts.eve))

  await relayClient.dev.newBlock()

  await checkEvents(voteEvents, "convictionVoting", "referenda")
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("events for eve's vote")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("referendum info after eve's vote")

  assert(referendumData.isOngoing)
  const ongoingRefThirdVote = referendumData.asOngoing

  votes.ayes += ayeVote / 10
  votes.nays += nayVote / 10
  votes.support += ayeVote + abstainVote
  await check(ongoingRefThirdVote.tally).toMatchObject(votes)

  const eveLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.eve.address)
  const localEveClassLocks = [[smallTipper[0], ayeVote + nayVote + abstainVote]]
  // Eve voted with `splitAbstain`, which does not allow expression of conviction in votes.
  assert(eveLockedFunds.eq(localEveClassLocks))

  // Check Eve's overall votes

  const votingByEve: PalletConvictionVotingVoteVoting =
    await relayClient.api.query.convictionVoting.votingFor(defaultAccounts.eve.address, smallTipper[0])
  assert(votingByEve.isCasting, "eve's votes are cast, not delegated")
  const eveCastVotes: PalletConvictionVotingVoteCasting = votingByEve.asCasting

  await check(eveCastVotes.votes[0][1]).redact({ removeKeys: unwantedRefIx}).toMatchSnapshot("eve's votes after casting hers")
  assert(eveCastVotes.votes.length === 1)
  assert(eveCastVotes.votes[0][0].eq(referendumIndex))

  const eveVote = eveCastVotes.votes[0][1].asSplitAbstain
  assert(eveVote.aye.eq(ayeVote))
  assert(eveVote.nay.eq(nayVote))
  assert(eveVote.abstain.eq(abstainVote))


  // AFter a vote the referendum's alarm is set to the block following the one the vote tx was
  // included in.
  ongoingRefThirdVote.alarm.unwrap()[0].eq(ongoingRefSecondVote.deciding.unwrap().since.add(new BN(1)))

  // Placing a split abstain vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, still counting down.
  referendumCmp(ongoingRefSecondVote, ongoingRefThirdVote, ['tally', 'alarm'])

  // Attempt to cancel the referendum with a signed origin - this should fail.
  
  const cancelRefCall = relayClient.api.tx.referenda.cancel(referendumIndex)
  const cancelRefEvents = await sendTransaction(cancelRefCall.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(cancelRefEvents, 'referenda', 'system')
    .toMatchSnapshot('cancelling referendum with signed origin')

  // Cancel the referendum using the scheduler pallet to simulate a root origin

  const number = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

  await relayClient.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [number + 1],
          [
            {
              call: {
                Inline: cancelRefCall.method.toHex(),
              },
              origin: {
                system: 'Root',
              },
            },
          ],
        ],
      ],
    },
  })

  await relayClient.dev.newBlock()

  /**
   * Check cancelled ref's data
   */

  // First, the emitted events
  // Retrieve the events for the latest block
  const events = await relayClient.api.query.system.events()

  const referendaEvents = events.filter((record) => {
    const { event } = record;
    return event.section === 'referenda'
  });

  assert(referendaEvents.length === 1, "cancelling a referendum should emit 1 event")

  const cancellationEvent = referendaEvents[0]
  assert(relayClient.api.events.referenda.Cancelled.is(cancellationEvent.event))

  const [index, tally] = cancellationEvent.event.data
  assert(index.eq(referendumIndex))
  assert(tally.eq(votes))

  // Now, check the referendum's data, post-cancellation

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  // cancelling a referendum does not remove it from storage
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")

  assert(referendumDataOpt.unwrap().isCancelled, "referendum should be cancelled!")
  const cancelledRef: ITuple<[u32, Option<PalletReferendaDeposit>, Option<PalletReferendaDeposit>]> = referendumDataOpt.unwrap().asCancelled

  cancelledRef[0].eq(referendumIndex)
  // Check that the referendum's submission deposit was refunded to Alice
  cancelledRef[1].unwrap().eq({
    who: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    amount: relayClient.api.consts.referenda.submissionDeposit
  })
  // Check that the referendum's submission deposit was refunded to Bob
  cancelledRef[2].unwrap().eq({
    who: encodeAddress(defaultAccounts.bob.address, addressEncoding),
    amount: smallTipper[1].decisionDeposit
  })

  const testAccounts = {
    'charlie': {
      classLocks: charlieClassLocks,
      localClassLocks: localCharlieClassLocks,
      votingBy: votingByCharlie,
    },
    'dave': {
      classLocks: daveLockedFunds,
      localClassLocks: localDaveClassLocks,
      votingBy: votingByDave,
    },
    'eve': {
      classLocks: eveLockedFunds,
      localClassLocks: localEveClassLocks,
      votingBy: votingByEve,
    },
  }

  // Check that cancelling the referendum has no effect on each voter's class locks
  for (const account of Object.keys(testAccounts)) {
    testAccounts[account].classLocks =
      await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts[account].address)
    assert(
      testAccounts[account].classLocks.eq(testAccounts[account].localClassLocks),
      `${account}'s class locks should be unaffected by referendum cancellation`
    )
  }

  // Check that cancelling the referendum has no effect on accounts' votes, as seen via `votingFor`
  // storage item.
  for (const account of Object.keys(testAccounts)) {
    const postCancellationVoting: PalletConvictionVotingVoteVoting =
      await relayClient.api.query.convictionVoting.votingFor(
        (defaultAccounts[account].address as string),
        smallTipper[0]
      )
    assert(postCancellationVoting.isCasting, `pre-referendum cancellation, ${account}'s votes were cast, not delegated`)
    const postCancellationCastVotes: PalletConvictionVotingVoteCasting = postCancellationVoting.asCasting
    assert(
      postCancellationVoting.eq(testAccounts[account].votingBy),
      `${account}'s votes should be unaffected by referendum cancellation`
    )
    await check((postCancellationCastVotes).votes[0][1])
      .redact({ removeKeys: unwantedRefIx})
      .toMatchSnapshot(`${account}'s votes after referendum's cancellation`)
  }

  /**
   * Vote withdrawal transactions, batched atomically.
   */

  const removeCharlieVote = relayClient.api.tx.convictionVoting.removeVote(smallTipper[0], referendumIndex).method
  const removeDaveVoteAsCharlie = relayClient.api.tx.convictionVoting.removeOtherVote(
    defaultAccounts.dave.address,
    smallTipper[0],
    referendumIndex
  ).method
  const removeEveVoteAsCharlie = relayClient.api.tx.convictionVoting.removeOtherVote(
    defaultAccounts.eve.address,
    smallTipper[0],
    referendumIndex
  ).method

  const batchAllTx = relayClient.api.tx.utility.batchAll([
    removeCharlieVote,
    removeDaveVoteAsCharlie,
    removeEveVoteAsCharlie,
  ])

  const batchEvents = await sendTransaction(batchAllTx.signAsync(defaultAccounts.charlie))

  await relayClient.dev.newBlock()

  await checkEvents(batchEvents)
    .redact({ removeKeys: new RegExp('who') })
    .toMatchSnapshot('removal of votes in cancelled referendum')

  // Check that each voter's class locks remain unaffected by vote removal - these are subject to a
  // later update.
  //
  // Also check that voting for each account is appropriately empty.
  for (const account of Object.keys(testAccounts)) {
    testAccounts[account].classLocks =
      await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts[account].address)
    assert(
      testAccounts[account].classLocks.eq(testAccounts[account].localClassLocks),
      `${account}'s class locks should be unaffected by vote removal`
    )
    await check(testAccounts[account].classLocks).toMatchSnapshot(`${account}'s class locks after their vote's rescission`)

    testAccounts[account].votingBy =
      await relayClient.api.query.convictionVoting.votingFor(defaultAccounts[account].address, smallTipper[0])
    assert(testAccounts[account].votingBy.isCasting)
    const castVotes = testAccounts[account].votingBy.asCasting
    await check(castVotes).toMatchSnapshot(`${account}'s votes after rescission`)
    assert(castVotes.votes.isEmpty)
  }

  // Check that submission and decision deposits are refunded to the respective voters.

  const submissionRefundTx = relayClient.api.tx.referenda.refundSubmissionDeposit(referendumIndex)
  const submissionRefundEvents = await sendTransaction(submissionRefundTx.signAsync(defaultAccounts.alice))
  const decisionRefundTx = relayClient.api.tx.referenda.refundDecisionDeposit(referendumIndex)
  const decisionRefundEvents = await sendTransaction(decisionRefundTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  await checkEvents(submissionRefundEvents, 'referenda')
    .redact({ removeKeys: new RegExp('index') })
    .toMatchSnapshot('refund of submission deposit')

  await checkEvents(decisionRefundEvents, 'referenda')
    .redact({ removeKeys: new RegExp('index') })
    .toMatchSnapshot('refund of decision deposit')
}

/**
 * Test the process of
 * 1. submitting a referendum for a treasury spend
 * 2. placing its decision deposit
 * 3. killing the referendum using the scheduler to insert a `Root`-origin call
 *   3.1 checking that submission/decision deposits are slashed
 */
export async function referendumLifecycleKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, addressEncoding: number) {
  /**
   * Setup relay and parachain clients
   */
  const [relayClient] = await setupNetworks(relayChain)

  // Fund test accounts not already provisioned in the test chain spec.
  await relayClient.dev.setStorage({
    System: {
      account: [
        [[defaultAccounts.alice.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccounts.bob.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  /**
   * Get current referendum count i.e. the next referendum's index
   */
  const referendumIndex = await relayClient.api.query.referenda.referendumCount()

  /**
   * Submit a new referendum
   */

  const submitReferendumTx = relayClient.api.tx.referenda.submit(
    {
      Origins: 'SmallTipper',
    } as any,
    {
      Inline: relayClient.api.tx.treasury.spendLocal(1e10, defaultAccounts.bob.address).method.toHex(),
    },
    {
      After: 1,
    },
  )
  await sendTransaction(submitReferendumTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  /**
   * Check the created referendum's data
   */

  const referendaTracks = relayClient.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.eq('small_tipper'))!

  /**
   * Place decision deposit
   */

  const decisionDepTx = relayClient.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  await sendTransaction(decisionDepTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  // Attempt to kill the referendum with a signed origin
  
  const killRefCall = relayClient.api.tx.referenda.kill(referendumIndex)
  const killRefEvents = await sendTransaction(killRefCall.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(killRefEvents, 'referenda', 'system').toMatchSnapshot('killing referendum with signed origin')


  /**
   * Kill the referendum using the scheduler pallet to simulate a root origin for the call.
   */

  const number = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

  await relayClient.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [number + 1],
          [
            {
              call: {
                Inline: killRefCall.method.toHex(),
              },
              origin: {
                system: 'Root',
              },
            },
          ],
        ],
      ],
    },
  })

  await relayClient.dev.newBlock()

  /**
   * Check killed ref's data
   */

  // Retrieve the events for the latest block
  const events = await relayClient.api.query.system.events()
  
  const referendaEvents = events.filter((record) => {
    const { event } = record;
    return event.section === 'referenda'
  });

  assert(referendaEvents.length === 3, "killing a referendum should emit 3 events")

  referendaEvents.forEach((record) => {
    const { event } = record;
    if (relayClient.api.events.referenda.Killed.is(event)) {
      const [index, tally] = event.data
      assert(index.eq(referendumIndex))
      assert(tally.eq({
        ayes: 0,
        nays: 0,
        support: 0,
      }))
    } else if (relayClient.api.events.referenda.DepositSlashed.is(event)) {
      const [who, amount] = event.data

      if (who.eq(encodeAddress(defaultAccounts.alice.address, addressEncoding))) {
        assert(amount.eq(relayClient.api.consts.referenda.submissionDeposit))
      } else if (who.eq(encodeAddress(defaultAccounts.bob.address, addressEncoding))) {
        assert(amount.eq(smallTipper[1].decisionDeposit))
      } else {
        assert(false, "malformed decision slashed events")
      }
    }
  })

  const referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  // killing a referendum does not remove it from storage, though it does prune most of its data.
  assert(referendumDataOpt.isSome, "referendum's data cannot be `None`")
  assert(referendumDataOpt.unwrap().isKilled, "referendum should be cancelled!")

  // The only information left from the killed referendum is the block number when it was killed.
  const blockNumber = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()
  const killedRef: u32 = referendumDataOpt.unwrap().asKilled
  assert(killedRef.eq(blockNumber))
}

/**
 * Test the registering, querying and unregistering a preimage; in this test, a `spend_local`
 * treasury call.
 */
export async function preimageTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  const [relayClient] = await setupNetworks(relayChain)

  const encodedProposal = relayClient.api.tx.treasury.spendLocal(1e10, defaultAccounts.bob.address).method
  const preimageTx = relayClient.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const preImageEvents = await sendTransaction(preimageTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')

  /**
   * Query noted preimage
   */

  let preimage = await relayClient.api.query.preimage.preimageFor(
    [
      encodedProposal.hash.toHex(),
      encodedProposal.encodedLength
    ]
  )

  assert(preimage.isSome)
  assert(preimage.unwrap().toHex() === encodedProposal.toHex())

  /**
   * Unnote preimage with the same account that had previously noted it
   */

  const unnotePreimageTx = relayClient.api.tx.preimage.unnotePreimage(encodedProposal.hash.toHex())
  const unnotePreImageEvents = await sendTransaction(unnotePreimageTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(unnotePreImageEvents, 'preimage').toMatchSnapshot('unnote preimage events')

  /**
   * Query unnoted preimage, and verify it is absent
   */

  preimage = await relayClient.api.query.preimage.preimageFor(
    [
      encodedProposal.hash.toHex(),
      encodedProposal.encodedLength
    ]
  )

  assert(preimage.isNone)
}

export function governanceE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  testConfig: { testSuiteName: string, addressEncoding: number, }
) {

  describe(testConfig.testSuiteName, function () {
    test(
      'referendum lifecycle test - submission, decision deposit, various voting should all work',
      async () => {
        await referendumLifecycleTest(relayChain, testConfig.addressEncoding)
      })

    test(
      'referendum lifecycle test 2 - submission, decision deposit, and killing should work',
      async () => {
        await referendumLifecycleKillTest(relayChain, testConfig.addressEncoding)
      })

    test(
      'preimage submission, query and removal works',
      async() => {
        await preimageTest(relayChain)
      })
  })
}
