import { assert, describe, test } from 'vitest'

import { Chain, defaultAccounts } from '@e2e-test/networks'
import { check, checkEvents } from '@e2e-test/shared/helpers'
import { setupNetworks } from '@e2e-test/shared'

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { Option } from '@polkadot/types'
import {
  PalletReferendaReferendumInfoConvictionVotingTally,
  PalletReferendaReferendumStatusConvictionVotingTally,
} from '@polkadot/types/lookup'
import { encodeAddress } from '@polkadot/util-crypto'

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
        [[defaultAccounts.charlie.address], { providers: 1, data: { free: 10e10 } }],
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
  // Check that the set alarm, to ring
  assert(blocksUntilAlarm.eq(relayClient.api.consts.referenda.undecidingTimeout))

  assert(ongoingRefPreDecDep.enactment.isAfter)
  await check(ongoingRefPreDecDep.enactment.asAfter).toMatchObject(1)

  const referendaTracks = relayClient.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.eq('small_tipper'))!
  assert(ongoingRefPreDecDep.track.eq(smallTipper[0]))
  await check(ongoingRefPreDecDep.origin).toMatchObject({
    origins: 'SmallTipper',
  })

  // Immediately after a referendum's submission, it will not have a decision deposit,
  // which it needs to begin the decision period.
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

  // Placing a decision deposit should not impact voting vounts.
  await check(ongoingRefPostDecDep.tally).toMatchObject(votes)

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

  // const [submittedEvent] = client.event.Referenda.Submitted.filter(tx.events)
  // check for events
}

export function governanceE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  describe('Polkadot Governance', function () {
    test(
      'submitting referendum, voting on it, and then cancelling it should work',
      { timeout: 1_000_000 },
      async () => {
        await submitReferendumThenCancel(relayChain, 0)
      },
    )
  })
}
