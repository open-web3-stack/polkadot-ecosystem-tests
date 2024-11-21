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
  await check(referendumData).redact({ removeKeys: unwantedFields }).toMatchSnapshot('referendum info')

  assert(referendumData.isOngoing)
  const ongoingRef: PalletReferendaReferendumStatusConvictionVotingTally = referendumData.asOngoing

  assert(ongoingRef.alarm.isSome)
  const undecidingTimeoutAlarm = ongoingRef.alarm.unwrap()[0]
  const blocksUntilAlarm = undecidingTimeoutAlarm.sub(ongoingRef.submitted)
  assert(blocksUntilAlarm.eq(relayClient.api.consts.referenda.undecidingTimeout))

  assert(ongoingRef.enactment.isAfter)
  await check(ongoingRef.enactment.asAfter).toMatchObject(1)

  const referendaTracks = relayClient.api.consts.referenda.tracks
  const smallTipper = referendaTracks.find((track) => track[1].name.eq('small_tipper'))!
  assert(ongoingRef.track.eq(smallTipper[0]))
  await check(ongoingRef.origin).toMatchObject({
    origins: 'SmallTipper',
  })
  assert(ongoingRef.deciding.isNone)
  assert(ongoingRef.decisionDeposit.isNone)

  assert(ongoingRef.submissionDeposit.who.eq(encodeAddress(defaultAccounts.alice.address, addressEncoding)))
  assert(ongoingRef.submissionDeposit.amount.eq(relayClient.api.consts.referenda.submissionDeposit))

  // Current voting state of the referendum.
  const votes = {
    ayes: 0,
    nays: 0,
    support: 0,
  }

  // Remove `tally` property from ongoing referendum pre and post-voting data
  const { tally: tally1, ...ongoingRefNoVotes } = ongoingRef

  // Check that voting data is empty
  await check(tally1).toMatchObject(votes)

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
  assert(referendumDataOpt, "submitted referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  assert(referendumData.isOngoing)
  const { tally: tally2, ...ongoingRefFirstVote } = referendumData.asOngoing

  // Check that, barring the recently introduced vote by alice, all else in the referendum's data
  // remains the same.
  await check(ongoingRefFirstVote).toMatchObject(ongoingRefNoVotes)

  // Alice voted with 3x conviction
  votes.ayes += ayeVote * 3
  votes.support += ayeVote
  await check(tally2).toMatchObject(votes)

  const aliceLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.alice.address)

  assert(aliceLockedFunds.eq([[smallTipper[0], ayeVote]]))

  // Fund test account's not already provisioned in the test chain spec.
  await relayClient.dev.setStorage({
    System: {
      account: [
        [[defaultAccounts.dave.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccounts.eve.address], { providers: 1, data: { free: 10e10 } }],
      ],
    },
  })

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
  assert(referendumDataOpt, "submitted referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  assert(referendumData.isOngoing)
  const { tally: tally3, ...ongoingRefSecondVote } = referendumData.asOngoing

  await check(ongoingRefSecondVote).toMatchObject(ongoingRefFirstVote)

  votes.ayes += ayeVote / 10
  votes.nays += nayVote / 10
  votes.support += ayeVote
  await check(tally3).toMatchObject(votes)

  // Dave voted with `split`, which does not allow expression of conviction in votes.
  const daveLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.dave.address)

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
  assert(referendumDataOpt, "submitted referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  assert(referendumData.isOngoing)
  const { tally: tally4, ...ongoingRefThirdVote } = referendumData.asOngoing

  await check(ongoingRefThirdVote).toMatchObject(ongoingRefSecondVote)

  votes.ayes += ayeVote / 10
  votes.nays += nayVote / 10
  votes.support += ayeVote + abstainVote
  await check(tally4).toMatchObject(votes)

  // Eve voted with `splitAbstain`, which does not allow expression of conviction in votes.
  const eveLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.eve.address)

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
