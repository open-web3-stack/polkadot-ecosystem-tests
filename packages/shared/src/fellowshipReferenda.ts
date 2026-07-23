/**
 * End-to-end tests for the Fellowship referenda pallet on the Collectives chain.
 *
 * Unlike a faked `Fellows` origin injected straight into the scheduler, these tests drive a real
 * Fellowship referendum: a seeded rank-3 member submits a proposal, casts a real ranked-collective
 * vote, and the referendum is fast-forwarded through its decision and confirmation periods via
 * storage surgery (only the clock is edited; the tally stays real). The enacted proposal then
 * whitelists a call on a destination chain (Asset Hub or the relay), exercising the genuine
 * cross-chain `WhitelistOrigin = EnsureXcm<IsFellowshipVoice>` path.
 *
 * @module
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks } from '@e2e-test/networks'

import { Keyring } from '@polkadot/keyring'
import type { HexString } from '@polkadot/util/types'

import { assert, expect } from 'vitest'

import {
  fellowshipCollectiveTx,
  passFellowshipReferendum,
  seedFellowshipMembers,
  submitFellowshipReferendum,
} from './fellowship.js'
import {
  assertExpectedEvents,
  checkSystemEvents,
  createXcmTransactSend,
  getXcmRoute,
  type TestConfig,
} from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

// The Fellows track requires a rank-3 member to submit and vote.
const FELLOWS_RANK = 3

/**
 * Geometric vote weight for a ranked-collective vote: `v*(v+1)/2` with `v = excess + 1`, where
 * `excess = rank - trackMinRank` (see `pallet_ranked_collective::{rank_to_votes, Geometric}`).
 * The weight depends on how far the voter's rank exceeds the track's minimum, not the raw rank.
 */
function geometricVotes(excessRank: number): number {
  const v = excessRank + 1
  return (v * (v + 1)) / 2
}

/**
 * Build the Fellowship referendum's enacted proposal: an XCM `Transact` sent from the Collectives
 * chain to the destination chain that runs `whitelist.whitelistCall(callHash)` under the exported
 * Fellowship voice. This mirrors the cross-chain shape that the destination's `WhitelistOrigin`
 * (`EnsureXcm<IsFellowshipVoice>`) accepts.
 */
function buildWhitelistViaXcm(destClient: Client<any, any>, collectivesClient: Client<any, any>, callHash: HexString) {
  const whitelistCall = destClient.api.tx.whitelist.whitelistCall(callHash).method.toHex() as HexString
  const dest = getXcmRoute(collectivesClient.config, destClient.config)
  return createXcmTransactSend(collectivesClient, dest, whitelistCall, 'Xcm', {
    proofSize: '10000',
    refTime: '1000000000',
  })
}

/**
 * Whitelist a call on the destination chain via a real, fast-forwarded Fellowship referendum on
 * Collectives.
 *
 * 1. Seed a controllable rank-3 fellow who can submit and vote on the Fellows track
 * 2. Run a real Fellowship referendum whose enacted proposal whitelists the call on the destination
 * 3. Check the enacted proposal emits the outbound XCM on Collectives
 * 4. Check the destination whitelists the call under the bridged Fellowship voice
 *
 * @param destClient The chain hosting the whitelist pallet whose `WhitelistOrigin` accepts the
 *   Fellowship voice (e.g. Asset Hub or the relay).
 * @param collectivesClient The Collectives chain hosting the Fellowship.
 */
export async function fellowshipWhitelistViaReferendum(
  destClient: Client<any, any>,
  collectivesClient: Client<any, any>,
) {
  const keyring = new Keyring({ type: 'sr25519' })
  const fellow = keyring.addFromUri('//fellowship_referenda_fellow')

  // A dummy 32-byte call hash to whitelist; its exact value is not important for the test.
  const callHash: HexString = '0x0101010101010101010101010101010101010101010101010101010101010101'

  /**
   * 1. Seed a controllable rank-3 fellow who can submit and vote on the Fellows track
   */

  await seedFellowshipMembers(collectivesClient, [{ pair: fellow, rank: FELLOWS_RANK }])

  /**
   * 2. Run a real Fellowship referendum whose enacted proposal whitelists the call on the destination
   */

  const proposal = buildWhitelistViaXcm(destClient, collectivesClient, callHash)
  await passFellowshipReferendum(collectivesClient, proposal, {
    track: { FellowshipOrigins: 'Fellows' },
    voters: [fellow],
  })

  /**
   * 3. Check the enacted proposal emits the outbound XCM on Collectives
   */

  await checkSystemEvents(collectivesClient, 'polkadotXcm')
    .redact({ hash: false, redactKeys: /messageId/ })
    .toMatchSnapshot('collectives sends fellowship whitelist xcm to the destination')

  /**
   * 4. Check the destination whitelists the call under the bridged Fellowship voice
   */

  await destClient.dev.newBlock()
  await checkSystemEvents(destClient, 'whitelist', 'messageQueue')
    .redact({ hash: false, redactKeys: /id/ })
    .toMatchSnapshot('destination whitelists the call via the fellowship voice')

  assertExpectedEvents(await destClient.api.query.system.events(), [
    { type: destClient.api.events.whitelist.CallWhitelisted, args: { callHash } },
  ])
}

/**
 * A member whose rank is below a track's minimum cannot vote on that track.
 *
 * A rank-2 member votes on the Fellows (rank-3) track; the runtime rejects it with `RankTooLow`.
 *
 * 1. Seed a rank-3 proposer (who can open the referendum) and a rank-2 member (who cannot vote)
 * 2. Open a Fellows-track referendum on a harmless remark
 * 3. Check the rank-2 member's vote is rejected with `RankTooLow`
 */
export async function rankTooLowCannotVote(collectivesClient: Client<any, any>) {
  const keyring = new Keyring({ type: 'sr25519' })
  const proposer = keyring.addFromUri('//fellowship_referenda_proposer')
  const lowRankMember = keyring.addFromUri('//fellowship_referenda_low_rank')

  /**
   * 1. Seed a rank-3 proposer (who can open the referendum) and a rank-2 member (who cannot vote)
   */

  await seedFellowshipMembers(collectivesClient, [
    { pair: proposer, rank: FELLOWS_RANK },
    { pair: lowRankMember, rank: FELLOWS_RANK - 1 },
  ])

  /**
   * 2. Open a Fellows-track referendum on a harmless remark
   */

  const remark = collectivesClient.api.tx.system.remark('rank-gating')
  const referendumIndex = await submitFellowshipReferendum(
    collectivesClient,
    remark,
    { FellowshipOrigins: 'Fellows' },
    proposer,
  )

  /**
   * 3. Check the rank-2 member's vote is rejected with `RankTooLow`
   */

  const collective = fellowshipCollectiveTx(collectivesClient)
  await sendTransaction(collective.vote(referendumIndex, true).signAsync(lowRankMember))
  await collectivesClient.dev.newBlock()

  assertExpectedEvents(await collectivesClient.api.query.system.events(), [
    {
      type: collectivesClient.api.events.system.ExtrinsicFailed,
      args: {
        dispatchError: (err: any) =>
          err.isModule && collectivesClient.api.errors.fellowshipCollective.RankTooLow.is(err.asModule),
      },
    },
  ])
}

/**
 * Vote weight in the ranked collective is geometric in rank: a single higher-rank aye contributes
 * `v*(v+1)/2` votes (`v = rank + 1`), so it can outweigh several lower-rank ayes.
 *
 * This votes with members of different ranks and checks the poll tally reflects the summed
 * geometric weights rather than a one-member-one-vote count.
 *
 * 1. Seed two fellows at different ranks (3 and 5)
 * 2. Open a Fellows-track referendum on a harmless remark
 * 3. The rank-3 member votes aye; the rank-5 member votes nay
 * 4. Check the tally reflects geometric weights over the excess rank above the track minimum
 */
export async function geometricVoteWeightAggregation(collectivesClient: Client<any, any>) {
  const keyring = new Keyring({ type: 'sr25519' })
  const rank3 = keyring.addFromUri('//fellowship_referenda_rank3')
  const rank5 = keyring.addFromUri('//fellowship_referenda_rank5')

  /**
   * 1. Seed two fellows at different ranks (3 and 5)
   */

  await seedFellowshipMembers(collectivesClient, [
    { pair: rank3, rank: 3 },
    { pair: rank5, rank: 5 },
  ])

  /**
   * 2. Open a Fellows-track referendum on a harmless remark
   */

  const remark = collectivesClient.api.tx.system.remark('geometric-weight')
  const referendumIndex = await submitFellowshipReferendum(
    collectivesClient,
    remark,
    { FellowshipOrigins: 'Fellows' },
    rank3,
  )

  /**
   * 3. The rank-3 member votes aye; the rank-5 member votes nay
   */

  const collective = fellowshipCollectiveTx(collectivesClient)
  await sendTransaction(collective.vote(referendumIndex, true).signAsync(rank3))
  await sendTransaction(collective.vote(referendumIndex, false).signAsync(rank5))
  await collectivesClient.dev.newBlock()

  /**
   * 4. Check the tally reflects geometric weights over the excess rank above the track minimum:
   *    the rank-3 aye contributes weight(0) and the rank-5 nay contributes weight(2)
   */

  const info = (await collectivesClient.api.query.fellowshipReferenda.referendumInfoFor(referendumIndex)) as any
  assert(info.isSome && info.unwrap().isOngoing, `referendum ${referendumIndex} not ongoing after voting`)
  const tally = info.unwrap().asOngoing.tally.toJSON() as { ayes: number; nays: number; bareAyes: number }

  expect(tally.ayes).toBe(geometricVotes(3 - FELLOWS_RANK))
  expect(tally.nays).toBe(geometricVotes(5 - FELLOWS_RANK))
  // `bareAyes` counts heads, not weight: one aye voter.
  expect(tally.bareAyes).toBe(1)
}

/**
 * Test runner for the Fellowship referenda E2E suite.
 *
 * @param destChain The chain hosting the whitelist pallet whose `WhitelistOrigin` accepts the
 *   Fellowship voice (e.g. Asset Hub Polkadot).
 * @param collectivesChain The Collectives chain hosting the Fellowship.
 */
export function fellowshipReferendaE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesDest extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  destChain: Chain<TCustom, TInitStoragesDest>,
  collectivesChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: TestConfig,
): RootTestTree {
  let destClient!: Client<TCustom, TInitStoragesDest>
  let collectivesClient!: Client<TCustom, TInitStoragesPara>
  let restoreSnapshot: () => Promise<void>

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[destClient, collectivesClient] = await createNetworks(destChain, collectivesChain)
      restoreSnapshot = captureSnapshot(destClient, collectivesClient)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      for (const c of [destClient, collectivesClient]) {
        const blockNumber = (await c.api.rpc.chain.getHeader()).number.toNumber()
        await c.dev.setHead(blockNumber)
      }
    },
    afterAll: async () => {
      for (const c of [destClient, collectivesClient]) {
        await c.api.disconnect().catch(() => {})
        await c.teardown().catch(() => {})
      }
    },
    children: [
      {
        kind: 'test',
        label: 'whitelist a call via a real fellowship referendum',
        flags: { timeout: 120_000 },
        testFn: async () => await fellowshipWhitelistViaReferendum(destClient, collectivesClient),
      },
      {
        kind: 'describe',
        label: 'voting behavior',
        children: [
          {
            kind: 'test',
            label: 'a member below the track rank cannot vote',
            flags: { timeout: 120_000 },
            testFn: async () => await rankTooLowCannotVote(collectivesClient),
          },
          {
            kind: 'test',
            label: 'vote weight is geometric in rank',
            flags: { timeout: 120_000 },
            testFn: async () => await geometricVoteWeightAggregation(collectivesClient),
          },
        ],
      },
    ],
  }
}
