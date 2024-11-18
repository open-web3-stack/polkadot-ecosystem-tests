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

  // Check that voting data is empty
  await check(ongoingRef.tally).toMatchObject({
    ayes: 0,
    nays: 0,
    support: 0,
  })

  /**
   * Vote on the referendum
   */

  const aliceAyeVote = 5e10
  const nayVote = 1e10

  const voteTx = relayClient.api.tx.convictionVoting.vote(referendumIndex, {
    Standard: {
      vote: {
        aye: true,
        conviction: 'Locked1x',
      },
      balance: aliceAyeVote,
    },
  })
  const voteEvents = await sendTransaction(voteTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  // Filtering for events only from the `convictionVoting` pallet would leave them empty.
  // Voting events were only introduced in
  // https://github.com/paritytech/polkadot-sdk/pull/4613
  await checkEvents(voteEvents).toMatchSnapshot('referendum vote events')

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt, "submitted referendum's data cannot be `None`")
  referendumData = referendumDataOpt.unwrap()

  assert(referendumData.isOngoing)
  const ongoingRefWithVotes = referendumData.asOngoing

  relayClient.api.tx.convictionVoting.unlock

  // Remove `tally` property from ongoing referendum pre and post-voting data
  const { tally: _tally1, ...ongoingRefNoTally } = ongoingRef
  const { tally: _tally2, ...ongoingRefWithVotesNoTally } = ongoingRefWithVotes

  // Check that, barring the recently introduced vote by alice, all else in the referendum's data
  // remains the same.
  await check(ongoingRefNoTally).toMatchObject(ongoingRefWithVotesNoTally)

  await check(ongoingRefWithVotes.tally).toMatchObject({
    ayes: 5e10,
    nays: 0,
    support: 5e10,
  })

  /*   const events = dotApi.event.Referenda.Submitted.filter(txFinalized.events)
  check(events).toMatchSnapshot('submit referendum from system')
 */
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
