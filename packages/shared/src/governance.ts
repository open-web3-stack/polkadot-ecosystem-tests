import { assert, describe, test } from 'vitest'

import { Chain, defaultAccounts } from '@e2e-test/networks'
import { check, checkEvents } from '@e2e-test/shared/helpers'
import { setupNetworks } from '@e2e-test/shared'

import { sendTransaction } from '@acala-network/chopsticks-testing'

import {
  FrameSupportPreimagesBounded,
  FrameSupportScheduleDispatchTime,
  KitchensinkRuntimeOriginCaller,
  PalletConvictionVotingTally,
  PalletReferendaDecidingStatus,
  PalletReferendaDeposit,
  PalletReferendaReferendumInfoConvictionVotingTally,
  PalletReferendaReferendumStatusConvictionVotingTally,
} from '@polkadot/types/lookup'
import { ITuple } from '@polkadot/types/types'
import { Option, bool, u16, u32 } from '@polkadot/types'
import { encodeAddress } from '@polkadot/util-crypto'

class OngoingReferendumStatus {
  readonly track!: u16
  readonly origin!: KitchensinkRuntimeOriginCaller
  readonly proposal!: FrameSupportPreimagesBounded
  readonly enactment!: FrameSupportScheduleDispatchTime
  readonly submitted!: u32
  readonly submissionDeposit!: PalletReferendaDeposit
  readonly decisionDeposit!: Option<PalletReferendaDeposit>
  readonly deciding!: Option<PalletReferendaDecidingStatus>
  readonly tally!: PalletConvictionVotingTally
  readonly inQueue!: bool
  readonly alarm!: Option<ITuple<[u32, ITuple<[u32, u32]>]>>
}

function referendumCmp(
  ref1: PalletReferendaReferendumStatusConvictionVotingTally,
  ref2: PalletReferendaReferendumStatusConvictionVotingTally,
  propertiesToBeSkipped: string[],
) {
  type ReferendumProperties = Array<keyof PalletReferendaReferendumStatusConvictionVotingTally>
  const properties: ReferendumProperties = Object.keys(new OngoingReferendumStatus()) as ReferendumProperties

  properties
    .filter((prop) => !propertiesToBeSkipped.includes(prop as string))
    .forEach((prop) => {
      if (ref1[(prop as string)!]!.eq(ref2[prop])) {
        console.log(`${String(prop)} was eq`)
      } else {
        console.log(`${String(prop)} was NOT eq`)
        console.log(`Left: ${ref1[prop]}`)
        console.log(`Right: ${ref2[prop]}`)
      }
    })
}

/**
 * Test the process of
 * 1. creating a referendum for a treasury spend
 * 2. voting on it
 * 3. cancelling it
 */
export async function submitReferendumThenCancel<
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
        [[defaultAccounts.dave.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccounts.eve.address], { providers: 1, data: { free: 10e10 } }],
      ],
    },
  })

  /*
  const preimageTx = relayClient.api.tx.preimage.notePreimage(encodedProposal)
  const preImageEvents = await sendTransaction(preimageTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')
  */

  /**
   * Get current referendum count i.e. the next referendum's index
   */
  const referendumIndex = await relayClient.api.query.referenda.referendumCount()

  /**
   * Submit a new referendum
   */
  const encodedProposal = relayClient.api.tx.treasury.spendLocal(1e10, defaultAccounts.bob.address).method.toHex()

  const submitReferendumTx = relayClient.api.tx.referenda.submit(
    {
      Origins: 'SmallTipper',
    } as any,
    {
      Inline: encodedProposal,
    },
    {
      After: 1,
    },
  )
  const submitReferendumEvents = await sendTransaction(submitReferendumTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  // Fields to be removed, check comment below.
  let unwantedFields: RegExp = new RegExp('index')
  await checkEvents(submitReferendumEvents, 'referenda')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('referendum submission events')

  /**
   * Check the created referendum's data
   */

  let referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt, "submitted referendum's data cannot be `None`")
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
  await check(ongoingRefPreDecDep.enactment.asAfter).toMatchObject(1)

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

  await checkEvents(decisiondepEvents, 'referenda').toMatchSnapshot("events for bob's decision deposit")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt, "referendum's data cannot be `None`")
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
   * Vote on the referendum
   */

  // Alice's vote
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
  let voteEvents = await sendTransaction(voteTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  // Filtering for events only from the `convictionVoting` pallet would leave them empty.
  // Voting events were only introduced in
  // https://github.com/paritytech/polkadot-sdk/pull/4613
  await checkEvents(voteEvents).toMatchSnapshot("events for alice's vote")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData)
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot("referendum info after alice's vote")

  assert(referendumData.isOngoing)
  const ongoingRefFirstVote = referendumData.asOngoing

  // Alice voted with 3x conviction
  votes.ayes += ayeVote * 3
  votes.support += ayeVote
  await check(ongoingRefFirstVote.tally).toMatchObject(votes)

  const aliceLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.alice.address)

  assert(aliceLockedFunds.eq([[smallTipper[0], ayeVote]]))

  // Placing a vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, which at this point should still be counting down.
  referendumCmp(ongoingRefPostDecDep, ongoingRefFirstVote, ['tally', 'alarm'])

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

  await checkEvents(voteEvents).toMatchSnapshot("events for dave's vote")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt, "referendum's data cannot be `None`")
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
  // Dave voted with `split`, which does not allow expression of conviction in votes.
  assert(daveLockedFunds.eq([[smallTipper[0], ayeVote + nayVote]]))

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

  await checkEvents(voteEvents).toMatchSnapshot("events for eve's vote")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt, "referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  await check(referendumData).redact({ removeKeys: unwantedFields }).toMatchSnapshot("referendum info after eve's vote")

  assert(referendumData.isOngoing)
  const ongoingRefThirdVote = referendumData.asOngoing

  votes.ayes += ayeVote / 10
  votes.nays += nayVote / 10
  votes.support += ayeVote + abstainVote
  await check(ongoingRefThirdVote.tally).toMatchObject(votes)

  const eveLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.eve.address)
  // Eve voted with `splitAbstain`, which does not allow expression of conviction in votes.
  assert(eveLockedFunds.eq([[smallTipper[0], ayeVote + nayVote + abstainVote]]))

  // Placing a split abstain vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, still counting down.
  referendumCmp(ongoingRefSecondVote, ongoingRefThirdVote, ['tally', 'alarm'])

  // const [submittedEvent] = client.event.Referenda.Submitted.filter(tx.events)
  // check for events
}

export function governanceE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  describe('Polkadot Governance', function () {
    test(
      'referendum lifecycle test - submission, decision deposit, various voting should all work',
      { timeout: 1_000_000 },
      async () => {
        await submitReferendumThenCancel(relayChain, 0)
      },
    )
  })
}
