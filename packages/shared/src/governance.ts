import { BN } from 'bn.js'
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

/**
 * Ongoing referenda are stored as `PalletReferendaReferendumStatusConvictionVotingTally`, an
 * interface in PJS.
 *
 * In TypeScript, it is not possible to get a list of an interface's properties.
 *
 * In order to get properties to then granularly compare the same referenda in different
 * stages, the below class is required, to then instantiate as as PJS's interface.
 */
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

/**
 * Compare the selected properties of two referenda.
 *
 * Fails if any of the properties to be compared
 * is different.
 * @param ref1
 * @param ref2
 * @param propertiesToBeSkipped List of properties to be skipped in the comparison
 */
function referendumCmp(
  ref1: PalletReferendaReferendumStatusConvictionVotingTally,
  ref2: PalletReferendaReferendumStatusConvictionVotingTally,
  propertiesToBeSkipped: string[],
  errorMsg?: string,
) {
  type ReferendumProperties = (keyof PalletReferendaReferendumStatusConvictionVotingTally)[]
  const properties: ReferendumProperties = Object.keys(new OngoingReferendumStatus()) as ReferendumProperties

  properties
    .filter((prop) => !propertiesToBeSkipped.includes(prop as string))
    .forEach((prop) => {
      const cmp = ref1[(prop as string)!]!.eq(ref2[prop])
      if (!cmp) {
        const msg = `Referenda differed on property \`${String(prop)}\`
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
    })
}

/**
 * Test the process of
 * 1. submitting a referendum for a treasury spend
 * 2. placing its decision deposit
 * 3. awaiting the end of the preparation period
 * 3. voting on it after the decision period has commenced
 *   3.1. using `vote`
 *   3.2. using a split vote
 *   3.3. using a split-abstain vote
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
  let unwantedFields = new RegExp('index')
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
   * Wait for decision period to elapse
   */

  let refPre = ongoingRefPostDecDep
  let refPost: PalletReferendaReferendumStatusConvictionVotingTally

  for (let i = 0; i < smallTipper[1].preparePeriod.toNumber() - 2; i++) {
    await relayClient.dev.newBlock()
      referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
      assert(referendumDataOpt, "referendum's data cannot be `None`")
      referendumData = referendumDataOpt.unwrap()
      assert(referendumData.isOngoing)
      refPost = referendumData.asOngoing

      referendumCmp(refPre, refPost, [], `Failed on iteration number ${i}.`)

      refPre = refPost
  }

  await relayClient.dev.newBlock()

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  const refNowDeciding = referendumDataOpt.unwrap().asOngoing

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

  // Check Alice's locked funds
  const aliceLockedFunds = await relayClient.api.query.convictionVoting.classLocksFor(defaultAccounts.alice.address)

  assert(aliceLockedFunds.eq(
    [
      [
        smallTipper[0],
        ayeVote
      ]
    ])
  )

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

  await checkEvents(voteEvents).toMatchSnapshot("events for eve's vote")

  referendumDataOpt = await relayClient.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(referendumDataOpt, "referendum's data cannot be `None`")
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
  // Eve voted with `splitAbstain`, which does not allow expression of conviction in votes.
  assert(eveLockedFunds.eq([[smallTipper[0], ayeVote + nayVote + abstainVote]]))

  // AFter a vote the referendum's alarm is set to the block following the one the vote tx was
  // included in.
  ongoingRefThirdVote.alarm.unwrap()[0].eq(ongoingRefSecondVote.deciding.unwrap().since.add(new BN(1)))

  // Placing a split abstain vote for a referendum should change nothing BUT:
  // 1. the tally, and
  // 2. its decision period, still counting down.
  referendumCmp(ongoingRefSecondVote, ongoingRefThirdVote, ['tally', 'alarm'])
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
        await referendumLifecycleTest(relayChain,testConfig.addressEncoding)
      },
      10_000_000)
  })
}
