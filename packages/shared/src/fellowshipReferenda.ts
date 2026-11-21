/**
 * End-to-end tests for `pallet-referenda` instances whose tally comes from a ranked collective:
 * the Fellowship and Ambassador referenda on the Collectives chain, and the Fellowship referenda on
 * the Kusama relay.
 *
 * The whitelist test drives a real Fellowship referendum rather than a faked `Fellows` origin
 * injected straight into the scheduler: a seeded rank-3 member submits a proposal, casts a real
 * ranked-collective vote, and the referendum is fast-forwarded through its decision and
 * confirmation periods via storage surgery (only the clock is edited; the tally stays real). The
 * enacted proposal then whitelists a call on a destination chain (Asset Hub or the relay),
 * exercising the genuine cross-chain `WhitelistOrigin = EnsureXcm<IsFellowshipVoice>` path.
 *
 * The remaining tests cover the pallet's calls against each runtime's own configuration. The same
 * pallet code backs every instance, so tests whose outcome depends on that configuration (who may
 * submit, cancel and kill; deposits; timeouts; where slashes go; how the tally counts) run on every
 * instance through `RankedReferendaTestConfig`, while paths that read no configuration run on the
 * Collectives Fellowship only.
 *
 * All three instances use the local `System` block number as their `BlockNumberProvider`, so every
 * referendum timing field below is a local block number.
 *
 * @module
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks } from '@e2e-test/networks'

import { Keyring } from '@polkadot/keyring'
import type { KeyringPair } from '@polkadot/keyring/types'
import { stringToHex, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import type { HexString } from '@polkadot/util/types'
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { passFellowshipReferendum, seedFellowshipMembers, submitFellowshipReferendum } from './fellowship.js'
import {
  assertExpectedEvents,
  checkSystemEvents,
  createXcmTransactSend,
  getXcmRoute,
  scheduleCallListWithOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { Client, RootTestTree, TestNode } from './types.js'

/// -------
/// Types
/// -------

/** A referendum track: its id and the proposal origin that the runtime's `TracksInfo` maps to it. */
export interface RankedReferendaTrack {
  /** Track id, as listed in the instance's `tracks` constant. */
  id: number
  /** Proposal origin that selects the track, for example `{ FellowshipOrigins: 'Fellows' }`. */
  origin: Record<string, string>
}

/** A signer that the instance's `SubmitOrigin` rejects, with the track it tries to submit on. */
export interface RejectedSubmitter {
  /** Collective rank the signer is seeded at. Left out for an account that is not a member. */
  rank?: number
  /** Track the signer tries to submit on. */
  track: RankedReferendaTrack
}

/** A dispatch origin as the scheduler stores it, for example `{ system: 'Root' }`. */
export type DispatchOrigin = Record<string, string>

/**
 * Non-signed origins that one of the instance's origin checks accepts, and a selection it rejects.
 * Signed origins are rejected by both `CancelOrigin` and `KillOrigin`, and are tested separately.
 */
export interface OriginMatrix {
  accepted: DispatchOrigin[]
  rejected: DispatchOrigin[]
}

/**
 * Parameters for one `pallet-referenda` instance tallied by a ranked collective.
 *
 * Kept on the test config rather than the chain definition because the Collectives chain hosts two
 * such instances, each with its own origins and tracks.
 */
export interface RankedReferendaTestConfig extends TestConfig {
  /** `api` section of the referenda instance. */
  referenda: 'fellowshipReferenda' | 'ambassadorReferenda'
  /** `api` section of the ranked collective whose members submit and vote. */
  collective: 'fellowshipCollective' | 'ambassadorCollective'
  /** Storage name of the same collective, used to seed members. */
  collectiveStorage: 'FellowshipCollective' | 'AmbassadorCollective'
  /**
   * The lowest rank that `SubmitOrigin` accepts on every track, and the instance's highest track.
   * A member of that rank submitting on the highest track shows the rank is enough everywhere.
   */
  submitAnyTrack: { rank: number; track: RankedReferendaTrack }
  /** Signers that `SubmitOrigin` rejects. */
  rejectedSubmitters: RejectedSubmitter[]
  /**
   * Track for the decision deposit and later tests, submitted on by a member of the
   * `submitAnyTrack` rank. Its prepare period must be non-zero, so that a deposit placed inside it
   * only prepares the referendum.
   */
  track: RankedReferendaTrack
  /** The lowest rank that may vote on `track`, from the runtime's `MinRankOfClass`. */
  trackMinRank: number
  /** Origins for `cancel`, from the runtime's `CancelOrigin`. */
  cancelOrigins: OriginMatrix
  /** Origins for `kill`, from the runtime's `KillOrigin`. */
  killOrigins: OriginMatrix
  /**
   * Where `kill` sends slashed deposits, from the runtime's `Slash` handler:
   * - `relayTreasury`: teleported over XCM to the relay chain's treasury account (`ToParentTreasury`);
   * - `treasury`: paid into the local treasury pot.
   */
  slashDestination: 'relayTreasury' | 'treasury'
  /**
   * A vote weight check on one track, from the runtime's `MinRankOfClass` and `VoteWeight`: a member
   * at `belowRank` cannot vote there, and each voter's aye weighs `weight`. Set for the instances
   * that have no other vote weight test.
   */
  voteWeights?: { track: RankedReferendaTrack; belowRank: number; voters: { rank: number; weight: number }[] }
}

/// -------
/// Helpers
/// -------

/** Keyring for the accounts these tests create; each seed names the instance and the account's role. */
const keyring = new Keyring({ type: 'sr25519' })

/**
 * The `api` sections of the referenda instance and ranked collective under test.
 *
 * Neither ranked referenda instance, nor either collective, is in the PJS type augmentation that
 * PET loads, so their sections are reached by name and are untyped.
 */
function instance(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const api = client.api as any
  return {
    tx: api.tx[cfg.referenda],
    query: api.query[cfg.referenda],
    events: api.events[cfg.referenda],
    errors: api.errors[cfg.referenda],
    consts: api.consts[cfg.referenda],
    collectiveTx: api.tx[cfg.collective],
    collectiveQuery: api.query[cfg.collective],
  }
}

/**
 * Free balance given to every account a test signs with: ten times the instance's largest decision
 * deposit. That covers any deposit plus fees on both the 10-decimal and the 12-decimal chains.
 */
function endowment(client: Client<any, any>, cfg: RankedReferendaTestConfig): bigint {
  const tracks = instance(client, cfg).consts.tracks as any[]
  const largest = tracks
    .map(([, info]) => info.decisionDeposit.toBigInt() as bigint)
    .reduce((max, deposit) => (deposit > max ? deposit : max), 0n)
  return largest * 10n
}

/** Give each account `free` balance and nothing else. */
async function fundAccounts(client: Client<any, any>, pairs: KeyringPair[], free: bigint): Promise<void> {
  await client.dev.setStorage({
    System: {
      account: pairs.map((pair) => [[pair.address], { providers: 1, data: { free, frozen: 0, reserved: 0 } }]),
    },
  })
}

/**
 * Seed funded members into the ranked collective that tallies the instance under test.
 *
 * Members are appended to the live collective, not swapped in for it: for each rank tier the live
 * `memberCount` is read and new members take the next indices. This keeps the per-tier index maps
 * consistent and leaves the real electorate in place, so support is measured against it.
 *
 * `seedFellowshipMembers` does the same for the Collectives Fellowship, but it also writes the
 * `FellowshipCore` pallet, which the Ambassador instance does not use and the Kusama relay lacks.
 */
async function seedRankedMembers(
  client: Client<any, any>,
  cfg: RankedReferendaTestConfig,
  members: { pair: KeyringPair; rank: number }[],
  free: bigint,
): Promise<void> {
  const { collectiveQuery } = instance(client, cfg)
  const maxRank = Math.max(...members.map(({ rank }) => rank))
  const memberCount: [[number], number][] = []
  const idToIndex: [[number, string], HexString][] = []
  const indexToId: [[number, number], string][] = []
  const expectedIndices: { rank: number; address: string; index: number }[] = []

  // A member of rank R belongs to every rank tier 0..R, so it is appended to and counted in each.
  for (let rank = 0; rank <= maxRank; rank++) {
    const membersAtRank = members.filter((member) => member.rank >= rank)
    const liveCount = (await collectiveQuery.memberCount(rank)).toNumber()
    for (const [offset, member] of membersAtRank.entries()) {
      const index = liveCount + offset
      // Chopsticks deletes a map entry whose value is falsy, so index 0 of an empty tier would be
      // dropped. The index is written as its SCALE encoding instead, which Chopsticks stores as is.
      idToIndex.push([[rank, member.pair.address], u8aToHex(client.api.createType('u32', index).toU8a())])
      indexToId.push([[rank, index], member.pair.address])
      expectedIndices.push({ rank, address: member.pair.address, index })
    }
    memberCount.push([[rank], liveCount + membersAtRank.length])
  }

  await fundAccounts(
    client,
    members.map(({ pair }) => pair),
    free,
  )
  await client.dev.setStorage({
    [cfg.collectiveStorage]: {
      members: members.map(({ pair, rank }) => [[pair.address], { rank }]),
      memberCount,
      idToIndex,
      indexToId,
    },
  })

  // Check every index entry took effect, in both directions.
  for (const { rank, address, index } of expectedIndices) {
    const storedIndex = await collectiveQuery.idToIndex(rank, address)
    expect(storedIndex.isSome && storedIndex.unwrap().toNumber(), `index of ${address} at rank ${rank}`).toBe(index)
    const storedId = await collectiveQuery.indexToId(rank, index)
    expect(storedId.isSome && storedId.unwrap().toString(), `member at index ${index} of rank ${rank}`).toBe(
      encodeAddress(address, client.config.properties.addressEncoding),
    )
  }
}

/** A `system.remark` call encoded for an `Inline` proposal. `text` makes it unique to the test. */
function remarkProposal(client: Client<any, any>, text: string): HexString {
  return client.api.tx.system.remark(text).method.toHex()
}

/**
 * The instance's `Submitted` events in the head block whose proposal is `proposal` inline.
 *
 * Matching on the proposal isolates a test's own submission from any other referendum.
 */
async function submittedEvents(client: Client<any, any>, cfg: RankedReferendaTestConfig, proposal: HexString) {
  const { events } = instance(client, cfg)
  return (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter(
      (event) =>
        events.Submitted.is(event) &&
        (event.data as any).proposal.isInline &&
        (event.data as any).proposal.asInline.toHex() === proposal,
    )
    .map((event) => event.data as any)
}

/**
 * Assert the head block holds exactly one `ExtrinsicFailed`, with the module error `name` from
 * `errors` (one pallet's `api.errors` section).
 *
 * The name is looked up in metadata first, so a renamed or removed variant fails the test rather
 * than matching nothing.
 */
async function expectExtrinsicError(client: Client<any, any>, errors: any, name: string): Promise<void> {
  assert(errors[name], `runtime has no error named ${name}`)
  const failures = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.system.ExtrinsicFailed.is(event),
  )
  expect(failures.length, 'exactly one extrinsic should fail').toBe(1)
  const { event } = failures[0]
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  const { dispatchError } = event.data
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  expect(errors[name].is(dispatchError.asModule)).toBe(true)
}

/** Assert the head block holds exactly one `ExtrinsicFailed`, failing with `BadOrigin`. */
async function expectExtrinsicBadOrigin(client: Client<any, any>): Promise<void> {
  const failures = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.system.ExtrinsicFailed.is(event),
  )
  expect(failures.length, 'exactly one extrinsic should fail').toBe(1)
  const { event } = failures[0]
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  expect(event.data.dispatchError.isBadOrigin, `expected BadOrigin, got ${event.data.dispatchError.type}`).toBe(true)
}

/**
 * Submit an inline remark on `track` from `submitter`, and return the new referendum's index.
 *
 * Setup for tests whose subject comes after submission; submission itself is checked by the
 * submission tests.
 */
async function submitReferendum(
  client: Client<any, any>,
  cfg: RankedReferendaTestConfig,
  submitter: KeyringPair,
  track: RankedReferendaTrack,
  text: string,
): Promise<number> {
  const proposal = remarkProposal(client, text)
  await sendTransaction(
    instance(client, cfg).tx.submit(track.origin, { Inline: proposal }, { After: 0 }).signAsync(submitter),
  )
  await client.dev.newBlock()
  const submitted = await submittedEvents(client, cfg, proposal)
  expect(submitted.length, `setup submission "${text}" should succeed`).toBe(1)
  return submitted[0].index.toNumber()
}

/** The stored status of referendum `index`, failing the test if the referendum is not ongoing. */
async function ongoingStatus(client: Client<any, any>, cfg: RankedReferendaTestConfig, index: number) {
  const info = await instance(client, cfg).query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isOngoing, `referendum ${index} should be ongoing`)
  return info.unwrap().asOngoing
}

/**
 * Overwrite time anchors of ongoing referendum `index`, keeping every other stored field.
 *
 * Only `submitted` and `deciding` (its `since` and `confirming` blocks) are changed, to skip
 * waiting periods. Tallies and deposits always come from real extrinsics. The write is read back,
 * so a test never runs on an anchor that did not take effect.
 */
async function setTimeAnchors(
  client: Client<any, any>,
  cfg: RankedReferendaTestConfig,
  index: number,
  anchors: { submitted?: number; deciding?: { since: number; confirming: number | null } },
): Promise<void> {
  const { query } = instance(client, cfg)
  const ongoing = await ongoingStatus(client, cfg, index)
  const valueType = client.api.registry.lookup.getTypeDef(query.referendumInfoFor.creator.meta.type.asMap.value).type
  const updated = client.api.registry.createType(valueType, { Ongoing: { ...ongoing.toJSON(), ...anchors } })
  await client.api.rpc('dev_setStorage', [[query.referendumInfoFor.key(index), updated.toHex()]])

  const stored = await ongoingStatus(client, cfg, index)
  if (anchors.submitted !== undefined) {
    expect(stored.submitted.toNumber(), 'backdated submitted block').toBe(anchors.submitted)
  }
  if (anchors.deciding !== undefined) {
    expect(stored.deciding.unwrap().since.toNumber(), 'backdated deciding block').toBe(anchors.deciding.since)
  }
}

/**
 * The `result` of every `scheduler.Dispatched` event in the head block, in order. A call injected
 * through the scheduler reports its outcome only here, never as `ExtrinsicFailed`.
 */
async function dispatchedResults(client: Client<any, any>) {
  return (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => client.api.events.scheduler.Dispatched.is(event))
    .map((event) => {
      assert(client.api.events.scheduler.Dispatched.is(event))
      return event.data.result
    })
}

/** The instance's configuration for track `id`, as listed in its `tracks` constant. */
function trackInfo(client: Client<any, any>, cfg: RankedReferendaTestConfig, id: number) {
  const entry = (instance(client, cfg).consts.tracks as any[]).find(([trackId]) => trackId.toNumber() === id)
  assert(entry, `track ${id} should exist on ${cfg.referenda}`)
  return entry[1]
}

/** The transaction fee `payer` was charged in the head block, from its `TransactionFeePaid` event. */
async function feePaidBy(client: Client<any, any>, payer: KeyringPair): Promise<bigint> {
  const fees = (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter(
      (event) =>
        client.api.events.transactionPayment.TransactionFeePaid.is(event) &&
        event.data.who.toHex() === u8aToHex(payer.publicKey),
    )
  expect(fees.length, 'the payer should pay exactly one fee in the block').toBe(1)
  assert(client.api.events.transactionPayment.TransactionFeePaid.is(fees[0]))
  return fees[0].data.actualFee.toBigInt()
}

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
function buildWhitelistViaXcm(destClient: any, collectivesClient: any, callHash: HexString) {
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
 * The Fellowship-side referendum lifecycle (Submitted, DecisionDepositPlaced, Voted, Confirmed)
 * is asserted inside `passFellowshipReferendum` block-by-block, so this test focuses on the
 * cross-chain effect.
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
export async function fellowshipWhitelistViaReferendum(destClient: any, collectivesClient: any) {
  const keyring = new Keyring({ type: 'sr25519' })
  const fellow = keyring.addFromUri('//fellowship_referenda_fellow')

  // A dummy 32-byte call hash to whitelist; its exact value is not important for the test.
  const callHash: HexString = '0x0101010101010101010101010101010101010101010101010101010101010101'

  // 1. Seed a controllable rank-3 fellow who can submit and vote on the Fellows track

  await seedFellowshipMembers(collectivesClient, [{ pair: fellow, rank: 3 }])

  // 2. Run a real Fellowship referendum whose enacted proposal whitelists the call on the destination

  const proposal = buildWhitelistViaXcm(destClient, collectivesClient, callHash)
  await passFellowshipReferendum(collectivesClient, proposal, {
    track: { FellowshipOrigins: 'Fellows' },
    voters: [fellow],
  })

  // 3. Check the enacted proposal emits the outbound XCM on Collectives

  await checkSystemEvents(collectivesClient, 'polkadotXcm')
    .redact({ hash: false, redactKeys: /messageId/ })
    .toMatchSnapshot('collectives sends fellowship whitelist xcm to the destination')

  // 4. Check the destination whitelists the call under the bridged Fellowship voice

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
 * 3. Check the rank-2 member is recorded at rank 2, and the referendum's tally is empty
 * 4. The rank-2 member votes aye
 * 5. Check the vote is rejected with `RankTooLow`, and the tally is unchanged
 */
export async function rankTooLowCannotVote(collectivesClient: any) {
  const keyring = new Keyring({ type: 'sr25519' })
  const proposer = keyring.addFromUri('//fellowship_referenda_proposer')
  const lowRankMember = keyring.addFromUri('//fellowship_referenda_low_rank')

  // 1. Seed a rank-3 proposer (who can open the referendum) and a rank-2 member (who cannot vote)

  await seedFellowshipMembers(collectivesClient, [
    { pair: proposer, rank: 3 },
    { pair: lowRankMember, rank: 2 },
  ])

  // 2. Open a Fellows-track referendum on a harmless remark

  const remark = collectivesClient.api.tx.system.remark('rank-gating')
  const referendumIndex = await submitFellowshipReferendum(
    collectivesClient,
    remark,
    { FellowshipOrigins: 'Fellows' },
    proposer,
  )

  // 3. The member is recorded at rank 2, and the tally is empty

  const member = await collectivesClient.api.query.fellowshipCollective.members(lowRankMember.address)
  expect(member.unwrap().rank.toNumber()).toBe(2)
  const tallyOf = async () =>
    (await collectivesClient.api.query.fellowshipReferenda.referendumInfoFor(referendumIndex))
      .unwrap()
      .asOngoing.tally.toJSON()
  expect(await tallyOf()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })

  // 4. The rank-2 member votes aye

  await sendTransaction(
    collectivesClient.api.tx.fellowshipCollective.vote(referendumIndex, true).signAsync(lowRankMember),
  )
  await collectivesClient.dev.newBlock()

  // 5. Rejected with `RankTooLow`, and the tally is unchanged

  await checkSystemEvents(collectivesClient, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'rank too low: ExtrinsicFailed',
  )
  assertExpectedEvents(await collectivesClient.api.query.system.events(), [
    {
      type: collectivesClient.api.events.system.ExtrinsicFailed,
      args: {
        dispatchError: (err: any) =>
          err.isModule && collectivesClient.api.errors.fellowshipCollective.RankTooLow.is(err.asModule),
      },
    },
  ])
  expect(await tallyOf()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })
}

/**
 * Vote weight in the ranked collective is geometric in the voter's rank above the track minimum:
 * a single higher-rank vote contributes `v*(v+1)/2` votes (`v = rank - trackMinRank + 1`), so it
 * can outweigh several lower-rank votes.
 *
 * This votes with members of different ranks and checks the poll tally reflects the summed
 * geometric weights rather than a one-member-one-vote count.
 *
 * 1. Seed two fellows at different ranks (3 and 5)
 * 2. Open a Fellows-track referendum on a harmless remark
 * 3. The rank-3 member votes aye; the rank-5 member votes nay
 * 4. Check each `Voted` event carries its voter and that vote's geometric weight
 * 5. Check the tally reflects geometric weights over the excess rank above the track minimum
 */
export async function geometricVoteWeightAggregation(collectivesClient: any) {
  const keyring = new Keyring({ type: 'sr25519' })
  const rank3 = keyring.addFromUri('//fellowship_referenda_rank3')
  const rank5 = keyring.addFromUri('//fellowship_referenda_rank5')

  // 1. Seed two fellows at different ranks (3 and 5)

  await seedFellowshipMembers(collectivesClient, [
    { pair: rank3, rank: 3 },
    { pair: rank5, rank: 5 },
  ])

  // 2. Open a Fellows-track referendum on a harmless remark

  const remark = collectivesClient.api.tx.system.remark('geometric-weight')
  const referendumIndex = await submitFellowshipReferendum(
    collectivesClient,
    remark,
    { FellowshipOrigins: 'Fellows' },
    rank3,
  )

  // 3. The rank-3 member votes aye; the rank-5 member votes nay

  await sendTransaction(collectivesClient.api.tx.fellowshipCollective.vote(referendumIndex, true).signAsync(rank3))
  await sendTransaction(collectivesClient.api.tx.fellowshipCollective.vote(referendumIndex, false).signAsync(rank5))
  await collectivesClient.dev.newBlock()

  // 4. Each `Voted` event carries its voter and weight

  await checkSystemEvents(collectivesClient, { section: 'fellowshipCollective', method: 'Voted' })
    .redact({ redactKeys: /^poll$/ })
    .toMatchSnapshot('geometric weight: Voted')
  const voted = (await collectivesClient.api.query.system.events())
    .map(({ event }: any) => event)
    .filter((event: any) => collectivesClient.api.events.fellowshipCollective.Voted.is(event))
    .map((event: any) => [event.data.who.toHex(), event.data.vote.toJSON()])
  expect(voted).toEqual([
    [u8aToHex(rank3.publicKey), { aye: geometricVotes(0) }],
    [u8aToHex(rank5.publicKey), { nay: geometricVotes(2) }],
  ])

  // 5. Check the tally reflects geometric weights over the excess rank above the Fellows track
  //    minimum: the rank-3 aye contributes weight(0) and the rank-5 nay contributes weight(2)

  const info = (await collectivesClient.api.query.fellowshipReferenda.referendumInfoFor(referendumIndex)) as any
  assert(info.isSome && info.unwrap().isOngoing, `referendum ${referendumIndex} not ongoing after voting`)
  const tally = info.unwrap().asOngoing.tally.toJSON() as { ayes: number; nays: number; bareAyes: number }

  expect(tally.ayes).toBe(geometricVotes(0))
  expect(tally.nays).toBe(geometricVotes(2))
  // `bareAyes` counts heads, not weight: one aye voter.
  expect(tally.bareAyes).toBe(1)
}

/// ----------
/// Submission
/// ----------

/**
 * A member at the lowest rank `SubmitOrigin` accepts on every track can open a referendum on the
 * instance's highest track, and the pallet records it in full.
 *
 * The pallet stores a submission deposit record for the submitter even when `SubmissionDeposit` is
 * zero, as it is on these runtimes. That record later decides who may set metadata and who a
 * refund goes to.
 *
 * 1. Seed a member at that rank, and record the referendum count and the member's reserve
 * 2. Submit an inline remark on the highest track
 * 3. Check the `Submitted` event carries the next index, the track and the proposal
 * 4. Check the stored referendum: ongoing, on that track and origin, submitted in this block, with
 *    a deposit record for the member, no decision deposit, an empty tally, and its timeout alarm
 * 5. Check the referendum count rose by one and the member's reserve grew by `SubmissionDeposit`
 */
export async function submitAtMinimumRank(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const { rank, track } = cfg.submitAnyTrack
  const submitter = keyring.addFromUri(`//${cfg.referenda}_submitter`)
  const submissionDeposit = referenda.consts.submissionDeposit.toBigInt()

  // 1. Seed a member at the lowest rank accepted on every track

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank }], endowment(client, cfg))
  const countBefore = (await referenda.query.referendumCount()).toNumber()
  const reservedBefore = (await client.api.query.system.account(submitter.address)).data.reserved.toBigInt()

  // 2. Submit an inline remark on the highest track

  const proposal = remarkProposal(client, `${cfg.referenda} submit at minimum rank`)
  const submitTx = referenda.tx.submit(track.origin, { Inline: proposal }, { After: 0 })
  await sendTransaction(submitTx.signAsync(submitter))
  await client.dev.newBlock()
  const submittedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 3. `Submitted` carries the next index, the track and the proposal

  await checkSystemEvents(client, { section: cfg.referenda, method: 'Submitted' })
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('submit at minimum rank: Submitted')

  const submitted = await submittedEvents(client, cfg, proposal)
  expect(submitted.length, 'exactly one Submitted event should carry the proposal').toBe(1)
  const index = submitted[0].index.toNumber()
  expect(index).toBe(countBefore)
  expect(submitted[0].track.toNumber()).toBe(track.id)

  // 4. The stored referendum

  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isOngoing, `referendum ${index} should be ongoing`)
  const ongoing = info.unwrap().asOngoing
  expect(ongoing.track.toNumber()).toBe(track.id)
  // The stored origin is the same codec as the call's first argument, so compare encodings.
  expect(ongoing.origin.toHex()).toBe(submitTx.method.args[0].toHex())
  expect(ongoing.proposal.isInline).toBe(true)
  expect(ongoing.proposal.asInline.toHex()).toBe(proposal)
  expect(ongoing.enactment.isAfter).toBe(true)
  expect(ongoing.enactment.asAfter.toNumber()).toBe(0)
  expect(ongoing.submitted.toNumber()).toBe(submittedAt)
  expect(ongoing.submissionDeposit.who.toHex()).toBe(u8aToHex(submitter.publicKey))
  expect(ongoing.submissionDeposit.amount.toBigInt()).toBe(submissionDeposit)
  expect(ongoing.decisionDeposit.isNone).toBe(true)
  expect(ongoing.deciding.isNone).toBe(true)
  expect(ongoing.tally.toJSON()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })
  expect(ongoing.inQueue.isTrue).toBe(false)
  // Without a decision deposit, the only alarm is the one that times the referendum out.
  assert(ongoing.alarm.isSome, `referendum ${index} should have an alarm`)
  expect(ongoing.alarm.unwrap()[0].toNumber()).toBe(submittedAt + referenda.consts.undecidingTimeout.toNumber())

  // 5. Referendum count and reserve

  expect((await referenda.query.referendumCount()).toNumber()).toBe(countBefore + 1)
  const reservedAfter = (await client.api.query.system.account(submitter.address)).data.reserved.toBigInt()
  expect(reservedAfter - reservedBefore).toBe(submissionDeposit)
}

/**
 * Signers below the rank that `SubmitOrigin` requires for a track, or outside the collective, cannot
 * open a referendum on it.
 *
 * Each signer submits in its own block, so each failure is attributed to its signer.
 *
 * 1. Seed each signer at its configured rank, or fund it as a non-member, and check the collective
 *    records it that way
 * 2. Each signer submits an inline remark on its configured track
 * 3. Check each submission fails with `BadOrigin` and emits no `Submitted`
 * 4. Check the referendum count is unchanged
 */
export async function submitRejectedOrigins(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const signers = cfg.rejectedSubmitters.map((signer) => ({
    ...signer,
    pair: keyring.addFromUri(`//${cfg.referenda}_rejected_rank_${signer.rank ?? 'none'}`),
    // Names the signer in snapshot keys and messages.
    name: signer.rank === undefined ? 'non-member' : `rank ${signer.rank}`,
  }))

  // 1. Seed or fund the signers, and check how the collective records them

  const free = endowment(client, cfg)
  await seedRankedMembers(
    client,
    cfg,
    signers.filter(({ rank }) => rank !== undefined).map(({ pair, rank }) => ({ pair, rank: rank! })),
    free,
  )
  await fundAccounts(
    client,
    signers.filter(({ rank }) => rank === undefined).map(({ pair }) => pair),
    free,
  )
  for (const { pair, rank, name } of signers) {
    const member = await referenda.collectiveQuery.members(pair.address)
    expect(member.isSome ? member.unwrap().rank.toNumber() : undefined, `${name} should be seeded as such`).toBe(rank)
  }

  const countBefore = (await referenda.query.referendumCount()).toNumber()

  for (const { pair, track, name } of signers) {
    // 2. Submit on the configured track

    const proposal = remarkProposal(client, `${cfg.referenda} rejected ${name}`)
    await sendTransaction(referenda.tx.submit(track.origin, { Inline: proposal }, { After: 0 }).signAsync(pair))
    await client.dev.newBlock()

    // 3. `BadOrigin`, and no `Submitted`

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      `submit by ${name} on track ${track.id}: ExtrinsicFailed`,
    )
    await expectExtrinsicBadOrigin(client)
    expect(await submittedEvents(client, cfg, proposal)).toHaveLength(0)
  }

  // 4. Referendum count unchanged

  expect((await referenda.query.referendumCount()).toNumber()).toBe(countBefore)
}

/**
 * A proposal origin that maps to no track is rejected with `NoTrack`, even from a signer that
 * `SubmitOrigin` accepts.
 *
 * `Root` is not the origin of any track on these instances, so `TracksInfo::track_for` finds none.
 *
 * 1. Seed a member at the lowest rank accepted on every track
 * 2. Submit an inline remark with a `Root` proposal origin
 * 3. Check the submission fails with `NoTrack` and emits no `Submitted`
 * 4. Check the referendum count is unchanged
 */
export async function submitWithoutTrack(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_no_track`)

  // 1. Seed a member at the lowest rank accepted on every track

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const countBefore = (await referenda.query.referendumCount()).toNumber()

  // 2. Submit with a `Root` proposal origin

  const proposal = remarkProposal(client, `${cfg.referenda} no track`)
  await sendTransaction(
    referenda.tx.submit({ system: 'Root' }, { Inline: proposal }, { After: 0 }).signAsync(submitter),
  )
  await client.dev.newBlock()

  // 3. `NoTrack`, and no `Submitted`

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'submit with a Root proposal origin: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NoTrack')
  expect(await submittedEvents(client, cfg, proposal)).toHaveLength(0)

  // 4. Referendum count unchanged

  expect((await referenda.query.referendumCount()).toNumber()).toBe(countBefore)
}

/**
 * On the Collectives Fellowship, a member below rank 3 may still open a referendum on a voice track,
 * as long as its rank is at least the rank that track's origin speaks for. The voice origins are
 * `Members` (rank 1) up to `Fellowship9Dan` (rank 9). Retention and promotion origins are not voices,
 * so those tracks stay closed below rank 3.
 *
 * Each member sends one `utility.forceBatch` of four submissions in its own block, so every item
 * reports its own outcome, in order.
 *
 * 1. Seed a rank-1 and a rank-2 member
 * 2. Each member batches submissions on the Members, Fellowship2Dan, Fellows and RetainAt1Dan tracks
 * 3. Check which items succeed: for rank 1 only Members, for rank 2 Members and Fellowship2Dan.
 *    Every other item fails with `BadOrigin`, and only the accepted tracks get a referendum.
 */
export async function submitOnVoiceTracks(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  // Track ids and origins from the Collectives Fellowship `TracksInfo::track_for`.
  const tracks: RankedReferendaTrack[] = [
    { id: 1, origin: { FellowshipOrigins: 'Members' } },
    { id: 2, origin: { FellowshipOrigins: 'Fellowship2Dan' } },
    { id: 3, origin: { FellowshipOrigins: 'Fellows' } },
    { id: 11, origin: { FellowshipOrigins: 'RetainAt1Dan' } },
  ]
  const cases = [
    { name: 'rank 1', rank: 1, acceptedTracks: [1] },
    { name: 'rank 2', rank: 2, acceptedTracks: [1, 2] },
  ].map((c) => ({ ...c, pair: keyring.addFromUri(`//${cfg.referenda}_voice_rank_${c.rank}`) }))

  // 1. Seed a rank-1 and a rank-2 member

  await seedRankedMembers(
    client,
    cfg,
    cases.map(({ pair, rank }) => ({ pair, rank })),
    endowment(client, cfg),
  )

  for (const { name, pair, acceptedTracks } of cases) {
    // 2. Batch one submission per track

    const submits = tracks.map((track) =>
      referenda.tx.submit(track.origin, { Inline: remarkProposal(client, `${name} voice ${track.id}`) }, { After: 0 }),
    )
    await sendTransaction(client.api.tx.utility.forceBatch(submits).signAsync(pair))
    await client.dev.newBlock()

    // 3. Only the accepted tracks succeed; the rest fail with `BadOrigin`

    await checkSystemEvents(client, 'utility', { section: cfg.referenda, method: 'Submitted' })
      .redact({ hash: false, redactKeys: /^index$/ })
      .toMatchSnapshot(`voice tracks, ${name}: batch items and Submitted`)

    const events = (await client.api.query.system.events()).map(({ event }) => event)
    const items = events.filter(
      (event) => client.api.events.utility.ItemCompleted.is(event) || client.api.events.utility.ItemFailed.is(event),
    )
    expect(items.map((event) => event.method)).toEqual(
      tracks.map((track) => (acceptedTracks.includes(track.id) ? 'ItemCompleted' : 'ItemFailed')),
    )
    for (const event of items.filter((event) => client.api.events.utility.ItemFailed.is(event))) {
      assert(client.api.events.utility.ItemFailed.is(event))
      expect(event.data.error.isBadOrigin, `${name} item failed with ${event.data.error.type}`).toBe(true)
    }
    expect(events.filter((event) => client.api.events.utility.BatchCompletedWithErrors.is(event))).toHaveLength(1)

    const submittedTracks = events
      .filter((event) => referenda.events.Submitted.is(event))
      .map((event) => (event.data as any).track.toNumber())
    expect(submittedTracks).toEqual(acceptedTracks)
  }
}

/**
 * On the Collectives Fellowship, an account in the `AllowedProposers` dynamic parameter may open a
 * referendum on any track without being a member. The list is set by governance and empty by
 * default.
 *
 * Setting the list is setup here, injected with a `Root` origin; the origin under test is
 * `SubmitOrigin`. Governance may already have filled the list, so the test relies only on its own
 * account being absent. It then replaces the list with that account: on a fork this only drops
 * entries no test uses, and it keeps the inline call within the scheduler's 128-byte limit.
 *
 * 1. Fund a non-member, and check it is not in the allow-list, whether or not the list is set
 * 2. Check the non-member's submission on the Fellowship9Dan track fails with `BadOrigin`
 * 3. Set the allow-list to that account through `parameters.setParameter` with `Root`
 * 4. Check the call dispatched, `parameters.Updated` was emitted, and the list holds the account
 * 5. Submit again from the account on the same track
 * 6. Check `Submitted`, and that the stored deposit record names the account
 */
export async function submitFromAllowList(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const proposer = keyring.addFromUri(`//${cfg.referenda}_allowed_proposer`)
  const track: RankedReferendaTrack = { id: 9, origin: { FellowshipOrigins: 'Fellowship9Dan' } }
  // The substrate type augmentation describes another runtime's parameters, so the Collectives
  // `parameters` pallet is reached untyped, like the referenda instances.
  const parameters = { tx: (client.api.tx as any).parameters, query: (client.api.query as any).parameters }
  const allowListKey = { Fellowship: 'AllowedProposers' }
  // The accounts in the allow-list, or none when the parameter has never been set.
  const allowList = async (): Promise<string[]> => {
    const value = await parameters.query.parameters(allowListKey)
    return value.isSome ? value.unwrap().asFellowship.asAllowedProposers.map((who: any) => who.toHex()) : []
  }

  // 1. Fund a non-member that is not in the allow-list

  await fundAccounts(client, [proposer], endowment(client, cfg))
  expect((await referenda.collectiveQuery.members(proposer.address)).isNone).toBe(true)
  expect(await allowList()).not.toContain(u8aToHex(proposer.publicKey))

  // 2. The non-member is rejected

  const firstProposal = remarkProposal(client, `${cfg.referenda} allow-list before`)
  await sendTransaction(referenda.tx.submit(track.origin, { Inline: firstProposal }, { After: 0 }).signAsync(proposer))
  await client.dev.newBlock()
  await expectExtrinsicBadOrigin(client)
  expect(await submittedEvents(client, cfg, firstProposal)).toHaveLength(0)

  // 3. Set the allow-list with `Root`. The key of the `AllowedProposers` parameter is a unit type.

  const setAllowList = parameters.tx.setParameter({
    Fellowship: { AllowedProposers: [null, [proposer.address]] },
  })
  await scheduleInlineCallWithOrigin(
    client,
    setAllowList.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. Dispatched, `parameters.Updated` emitted, and the list holds the account

  // `oldValue` is whatever governance had set at the fork point, so it is redacted.
  await checkSystemEvents(client, 'parameters', { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^(task|oldValue)$/ })
    .toMatchSnapshot('allow-list: set by Root')
  expect(
    (await dispatchedResults(client)).map((result) => result.isOk),
    'setting the allow-list should dispatch',
  ).toEqual([true])
  const updated = (await client.api.query.system.events()).filter(({ event }) =>
    client.api.events.parameters.Updated.is(event),
  )
  expect(updated).toHaveLength(1)
  expect(await allowList()).toEqual([u8aToHex(proposer.publicKey)])

  // 5. Submit again from the allow-listed account

  const secondProposal = remarkProposal(client, `${cfg.referenda} allow-list after`)
  await sendTransaction(referenda.tx.submit(track.origin, { Inline: secondProposal }, { After: 0 }).signAsync(proposer))
  await client.dev.newBlock()

  // 6. `Submitted`, with the deposit record naming the account

  await checkSystemEvents(client, { section: cfg.referenda, method: 'Submitted' })
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('allow-list: Submitted')
  const submitted = await submittedEvents(client, cfg, secondProposal)
  expect(submitted.length, 'exactly one Submitted event should carry the proposal').toBe(1)
  expect(submitted[0].track.toNumber()).toBe(track.id)

  const info = await referenda.query.referendumInfoFor(submitted[0].index.toNumber())
  assert(info.isSome && info.unwrap().isOngoing, 'the allow-listed referendum should be ongoing')
  expect(info.unwrap().asOngoing.submissionDeposit.who.toHex()).toBe(u8aToHex(proposer.publicKey))
}

/**
 * A `Lookup` proposal whose length disagrees with the noted preimage is rejected before any
 * referendum is created.
 *
 * 1. Seed a rank-3 member and note the preimage of a remark
 * 2. Check the preimage is recorded with its true length
 * 3. Submit a `Lookup` for that hash with the length off by one
 * 4. Check the submission fails with `PreimageStoredWithDifferentLength` and emits no `Submitted`
 * 5. Check the referendum count is unchanged
 */
export async function submitWithWrongPreimageLength(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_preimage_length`)
  const call = client.api.tx.system.remark(`${cfg.referenda} wrong preimage length`).method
  const hash = call.hash.toHex()

  // 1. Seed a rank-3 member and note the preimage

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await sendTransaction(client.api.tx.preimage.notePreimage(call.toHex()).signAsync(submitter))
  await client.dev.newBlock()

  // 2. The preimage is recorded with its true length

  const status = await client.api.query.preimage.requestStatusFor(hash)
  assert(status.isSome && status.unwrap().isUnrequested, 'the preimage should be noted and unrequested')
  expect(status.unwrap().asUnrequested.len.toNumber()).toBe(call.encodedLength)
  const countBefore = (await referenda.query.referendumCount()).toNumber()

  // 3. Submit a `Lookup` with the length off by one

  await sendTransaction(
    referenda.tx
      .submit(cfg.submitAnyTrack.track.origin, { Lookup: { hash, len: call.encodedLength + 1 } }, { After: 0 })
      .signAsync(submitter),
  )
  await client.dev.newBlock()

  // 4. `PreimageStoredWithDifferentLength`, and no `Submitted`

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'submit with a wrong preimage length: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'PreimageStoredWithDifferentLength')
  const events = (await client.api.query.system.events()).map(({ event }) => event)
  expect(events.filter((event) => referenda.events.Submitted.is(event))).toHaveLength(0)

  // 5. Referendum count unchanged

  expect((await referenda.query.referendumCount()).toNumber()).toBe(countBefore)
}

/// ----------------
/// Decision deposit
/// ----------------

/**
 * Anyone may pay a referendum's decision deposit, not only its submitter or a member. Paid inside
 * the track's prepare period, the deposit only prepares the referendum: it reserves the track's
 * deposit from the payer and moves the referendum's alarm to the end of the prepare period.
 *
 * 1. Seed a submitter, fund a non-member payer, and submit on the configured track
 * 2. The payer places the decision deposit
 * 3. Check `DecisionDepositPlaced` names the referendum, the payer and the track's deposit
 * 4. Check the payer's reserve rose by the deposit, and its free balance fell by the deposit plus
 *    the fee
 * 5. Check the referendum records the deposit, is not deciding, and wakes at the end of the
 *    prepare period; the track's deciding count is unchanged
 */
export async function placeDepositInPreparePeriod(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_deposit_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_deposit_payer`)
  const track = trackInfo(client, cfg, cfg.track.id)
  const deposit = track.decisionDeposit.toBigInt()

  // 1. Seed a submitter, fund a non-member payer, and submit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  expect((await referenda.collectiveQuery.members(payer.address)).isNone).toBe(true)
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} deposit in prepare period`)
  const { submitted } = await ongoingStatus(client, cfg, index)
  const decidingCountBefore = (await referenda.query.decidingCount(cfg.track.id)).toNumber()
  const before = (await client.api.query.system.account(payer.address)).data

  // 2. The payer places the decision deposit

  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()

  // 3. `DecisionDepositPlaced`

  await checkSystemEvents(client, { section: cfg.referenda, method: 'DecisionDepositPlaced' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('deposit in prepare period: DecisionDepositPlaced')
  const placed = (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter(
      (event) => referenda.events.DecisionDepositPlaced.is(event) && (event.data as any).index.toNumber() === index,
    )
  expect(placed).toHaveLength(1)
  const placedData = placed[0].data as any
  expect(placedData.who.toHex()).toBe(u8aToHex(payer.publicKey))
  expect(placedData.amount.toBigInt()).toBe(deposit)

  // 4. Payer balances

  const fee = await feePaidBy(client, payer)
  const after = (await client.api.query.system.account(payer.address)).data
  expect(after.reserved.toBigInt() - before.reserved.toBigInt()).toBe(deposit)
  expect(before.free.toBigInt() - after.free.toBigInt()).toBe(deposit + fee)

  // 5. Stored referendum: prepared, not deciding

  const ongoing = await ongoingStatus(client, cfg, index)
  assert(ongoing.decisionDeposit.isSome, 'the decision deposit should be recorded')
  expect(ongoing.decisionDeposit.unwrap().who.toHex()).toBe(u8aToHex(payer.publicKey))
  expect(ongoing.decisionDeposit.unwrap().amount.toBigInt()).toBe(deposit)
  expect(ongoing.deciding.isNone).toBe(true)
  expect(ongoing.inQueue.isTrue).toBe(false)
  expect(ongoing.alarm.unwrap()[0].toNumber()).toBe(submitted.toNumber() + track.preparePeriod.toNumber())
  expect((await referenda.query.decidingCount(cfg.track.id)).toNumber()).toBe(decidingCountBefore)
}

/**
 * A decision deposit placed after the prepare period has passed starts the decision in the same
 * extrinsic, when the track has a free deciding slot.
 *
 * The prepare period is skipped by moving the referendum's `submitted` block back by the prepare
 * period. Nothing else about the referendum is edited.
 *
 * 1. Seed a submitter, fund a payer, submit on the configured track, and check the track has a
 *    free deciding slot
 * 2. Move `submitted` back by the prepare period
 * 3. The payer places the decision deposit
 * 4. Check `DecisionDepositPlaced` and `DecisionStarted` for the referendum, with its track,
 *    proposal and empty tally
 * 5. Check the referendum is deciding from this block, is not confirming, and wakes at the end of
 *    the decision period; the track's deciding count rose by one
 */
export async function placeDepositAfterPreparePeriod(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_deciding_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_deciding_payer`)
  const track = trackInfo(client, cfg, cfg.track.id)

  // 1. Seed, fund, submit, and check there is a free deciding slot

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const proposal = remarkProposal(client, `${cfg.referenda} deposit after prepare period`)
  const index = await submitReferendum(
    client,
    cfg,
    submitter,
    cfg.track,
    `${cfg.referenda} deposit after prepare period`,
  )
  const decidingCountBefore = (await referenda.query.decidingCount(cfg.track.id)).toNumber()
  expect(decidingCountBefore, 'the track needs a free deciding slot').toBeLessThan(track.maxDeciding.toNumber())

  // 2. Move `submitted` back by the prepare period

  const head = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await setTimeAnchors(client, cfg, index, { submitted: head - track.preparePeriod.toNumber() })

  // 3. The payer places the decision deposit

  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()
  const decidingFrom = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 4. `DecisionDepositPlaced` and `DecisionStarted`

  await checkSystemEvents(
    client,
    { section: cfg.referenda, method: 'DecisionDepositPlaced' },
    { section: cfg.referenda, method: 'DecisionStarted' },
  )
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('deposit after prepare period: DecisionDepositPlaced and DecisionStarted')
  const started = (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => referenda.events.DecisionStarted.is(event) && (event.data as any).index.toNumber() === index)
  expect(started).toHaveLength(1)
  const startedData = started[0].data as any
  expect(startedData.track.toNumber()).toBe(cfg.track.id)
  expect(startedData.proposal.asInline.toHex()).toBe(proposal)
  expect(startedData.tally.toJSON()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })

  // 5. Deciding from this block, and one more deciding referendum on the track

  const ongoing = await ongoingStatus(client, cfg, index)
  assert(ongoing.deciding.isSome, 'the referendum should be deciding')
  expect(ongoing.deciding.unwrap().since.toNumber()).toBe(decidingFrom)
  expect(ongoing.deciding.unwrap().confirming.isNone).toBe(true)
  // An empty tally meets neither curve before the decision period ends, so that is when it wakes.
  expect(ongoing.alarm.unwrap()[0].toNumber()).toBe(decidingFrom + track.decisionPeriod.toNumber())
  expect((await referenda.query.decidingCount(cfg.track.id)).toNumber()).toBe(decidingCountBefore + 1)
}

/**
 * A referendum takes one decision deposit. A second payer's deposit is refused with `HasDeposit`,
 * and nothing is reserved from that payer.
 *
 * 1. Seed a submitter, fund two payers, submit, and let the first payer place the deposit
 * 2. The second payer places a deposit on the same referendum
 * 3. Check it fails with `HasDeposit`
 * 4. Check the recorded deposit still names the first payer, and the second payer's reserve is
 *    unchanged
 */
export async function placeDepositTwice(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_twice_submitter`)
  const firstPayer = keyring.addFromUri(`//${cfg.referenda}_twice_first`)
  const secondPayer = keyring.addFromUri(`//${cfg.referenda}_twice_second`)

  // 1. Submit, and let the first payer place the deposit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [firstPayer, secondPayer], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} deposit twice`)
  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(firstPayer))
  await client.dev.newBlock()
  assert((await ongoingStatus(client, cfg, index)).decisionDeposit.isSome, 'the first deposit should be recorded')
  const reservedBefore = (await client.api.query.system.account(secondPayer.address)).data.reserved.toBigInt()

  // 2. A second deposit on the same referendum

  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(secondPayer))
  await client.dev.newBlock()

  // 3. `HasDeposit`

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'deposit twice: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'HasDeposit')

  // 4. The first deposit stands; the second payer reserved nothing

  expect((await ongoingStatus(client, cfg, index)).decisionDeposit.unwrap().who.toHex()).toBe(
    u8aToHex(firstPayer.publicKey),
  )
  const reservedAfter = (await client.api.query.system.account(secondPayer.address)).data.reserved.toBigInt()
  expect(reservedAfter).toBe(reservedBefore)
}

/**
 * A decision deposit can only be placed on an ongoing referendum: an index that was never used, and
 * a referendum that was cancelled, both fail with `NotOngoing`.
 *
 * The cancellation is setup, injected with the Collectives Fellowship's `Architects` origin, which
 * is its cancel origin.
 *
 * 1. Seed a submitter, fund a payer, submit, and cancel that referendum
 * 2. The payer places a deposit on an index past `ReferendumCount`
 * 3. Check it fails with `NotOngoing`
 * 4. The payer places a deposit on the cancelled referendum
 * 5. Check it fails with `NotOngoing`, and the payer's reserve is unchanged throughout
 */
export async function placeDepositNotOngoing(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_not_ongoing_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_not_ongoing_payer`)

  // 1. Submit and cancel a referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} deposit not ongoing`)
  await scheduleInlineCallWithOrigin(
    client,
    referenda.tx.cancel(index).method.toHex(),
    { FellowshipOrigins: 'Architects' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  expect(
    (await dispatchedResults(client)).map((result) => result.isOk),
    'the setup cancel should dispatch',
  ).toEqual([true])
  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isCancelled, 'setup cancel should end the referendum')
  const reservedBefore = (await client.api.query.system.account(payer.address)).data.reserved.toBigInt()

  // 2. and 3. An index that was never used

  const unusedIndex = (await referenda.query.referendumCount()).toNumber() + 1000
  expect((await referenda.query.referendumInfoFor(unusedIndex)).isNone).toBe(true)
  await sendTransaction(referenda.tx.placeDecisionDeposit(unusedIndex).signAsync(payer))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'deposit on an unused index: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NotOngoing')

  // 4. and 5. The cancelled referendum

  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'deposit on a cancelled referendum: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NotOngoing')
  expect((await client.api.query.system.account(payer.address)).data.reserved.toBigInt()).toBe(reservedBefore)
}

/**
 * A payer whose free balance is below the track's decision deposit cannot place it. The reserve
 * fails in `pallet-balances` with `InsufficientBalance`, and no deposit is recorded.
 *
 * 1. Seed a submitter and submit, then fund a payer with one unit less than the deposit
 * 2. The payer places the decision deposit
 * 3. Check it fails with `balances.InsufficientBalance`
 * 4. Check no deposit is recorded and the payer's reserve is still zero
 */
export async function placeDepositUnaffordable(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_unaffordable_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_unaffordable_payer`)
  const deposit = trackInfo(client, cfg, cfg.track.id).decisionDeposit.toBigInt()

  // 1. Submit, and fund the payer just below the deposit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} deposit unaffordable`)
  await fundAccounts(client, [payer], deposit - 1n)

  // 2. The payer places the decision deposit

  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()

  // 3. `balances.InsufficientBalance`

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'deposit unaffordable: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, client.api.errors.balances, 'InsufficientBalance')

  // 4. Nothing recorded or reserved

  expect((await ongoingStatus(client, cfg, index)).decisionDeposit.isNone).toBe(true)
  expect((await client.api.query.system.account(payer.address)).data.reserved.toBigInt()).toBe(0n)
}

/// ---------------
/// Cancel and kill
/// ---------------

/**
 * Submit one referendum per payer on the configured track, then have each payer place its
 * decision deposit in one block. Returns the referendum indices, in payer order.
 *
 * Setup for the cancel and kill tests, which need ongoing referenda holding both deposits.
 */
async function submitWithDeposits(
  client: Client<any, any>,
  cfg: RankedReferendaTestConfig,
  submitter: KeyringPair,
  payers: KeyringPair[],
  text: string,
): Promise<number[]> {
  const referenda = instance(client, cfg)
  const indices: number[] = []
  for (const [i, payer] of payers.entries()) {
    indices.push(await submitReferendum(client, cfg, submitter, cfg.track, `${text} ${i}`))
    await sendTransaction(referenda.tx.placeDecisionDeposit(indices[i]).signAsync(payer))
  }
  await client.dev.newBlock()
  for (const index of indices) {
    assert((await ongoingStatus(client, cfg, index)).decisionDeposit.isSome, `setup deposit on ${index} should succeed`)
  }
  return indices
}

/**
 * Each origin the instance's `CancelOrigin` accepts can cancel an ongoing referendum. A cancelled
 * referendum keeps both deposits on hold until they are refunded, and its alarm is removed from
 * the scheduler.
 *
 * One referendum is opened per accepted origin, and every cancel is injected into the same block.
 *
 * 1. Seed a submitter; per accepted origin, submit a referendum and have a non-member pay its
 *    decision deposit
 * 2. Inject one `cancel` per referendum, each with its own accepted origin
 * 3. Check every injected call dispatched, and each referendum emits `Cancelled` with its tally
 * 4. Check each referendum is stored as cancelled in this block, still holding both deposits
 * 5. Check each payer's reserve still holds the deposit, each referendum's alarm is gone from the
 *    scheduler, and the track's deciding count is unchanged
 */
export async function cancelByAcceptedOrigins(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_cancel_submitter`)
  const payers = cfg.cancelOrigins.accepted.map((_, i) => keyring.addFromUri(`//${cfg.referenda}_cancel_payer_${i}`))
  const deposit = trackInfo(client, cfg, cfg.track.id).decisionDeposit.toBigInt()

  // 1. One referendum per accepted origin, each holding a decision deposit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, payers, endowment(client, cfg))
  const indices = await submitWithDeposits(client, cfg, submitter, payers, `${cfg.referenda} cancel`)
  const alarms = await Promise.all(
    indices.map(async (index) => (await ongoingStatus(client, cfg, index)).alarm.unwrap()[1]),
  )
  const reservedBefore = await Promise.all(
    payers.map(async (payer) => (await client.api.query.system.account(payer.address)).data.reserved.toBigInt()),
  )
  const decidingCountBefore = (await referenda.query.decidingCount(cfg.track.id)).toNumber()

  // 2. Inject the cancels

  await scheduleCallListWithOrigin(
    client,
    indices.map((index, i) => ({
      call: { Inline: referenda.tx.cancel(index).method.toHex() },
      origin: cfg.cancelOrigins.accepted[i],
    })),
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  const cancelledAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 3. Every cancel dispatched, and each referendum emits `Cancelled`

  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: cfg.referenda, method: 'Cancelled' },
  )
    .redact({ redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('cancel by accepted origins: Dispatched and Cancelled')
  expect((await dispatchedResults(client)).map((result) => result.isOk)).toEqual(indices.map(() => true))
  const cancelled = (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => referenda.events.Cancelled.is(event))
    .map((event) => event.data as any)
  expect(cancelled.map((data) => data.index.toNumber())).toEqual(indices)
  for (const data of cancelled) {
    expect(data.tally.toJSON()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })
  }

  for (const [i, index] of indices.entries()) {
    // 4. Stored as cancelled in this block, holding both deposits

    const info = await referenda.query.referendumInfoFor(index)
    assert(info.isSome && info.unwrap().isCancelled, `referendum ${index} should be cancelled`)
    const [moment, submission, decision] = info.unwrap().asCancelled
    expect(moment.toNumber()).toBe(cancelledAt)
    expect(submission.unwrap().who.toHex()).toBe(u8aToHex(submitter.publicKey))
    expect(submission.unwrap().amount.toBigInt()).toBe(referenda.consts.submissionDeposit.toBigInt())
    expect(decision.unwrap().who.toHex()).toBe(u8aToHex(payers[i].publicKey))
    expect(decision.unwrap().amount.toBigInt()).toBe(deposit)

    // 5. The deposit stays reserved, and the alarm is gone

    const reservedAfter = (await client.api.query.system.account(payers[i].address)).data.reserved.toBigInt()
    expect(reservedAfter).toBe(reservedBefore[i])
    const [alarmBlock, alarmIndex] = alarms[i]
    const block: number = alarmBlock.toNumber()
    const slot: number = alarmIndex.toNumber()
    const agenda = [...(await client.api.query.scheduler.agenda(block))]
    expect(agenda.length <= slot || agenda[slot].isNone, `alarm of referendum ${index} should be gone`).toBe(true)
  }
  expect((await referenda.query.decidingCount(cfg.track.id)).toNumber()).toBe(decidingCountBefore)
}

/**
 * Origins outside the instance's `CancelOrigin` cannot cancel a referendum: each injected cancel
 * fails with `BadOrigin`, and so does a cancel signed by the referendum's own submitter.
 *
 * 1. Seed a submitter and submit a referendum
 * 2. Inject one `cancel` per rejected origin into the same block
 * 3. Check each dispatched with `BadOrigin`
 * 4. The submitter signs a `cancel`
 * 5. Check it fails with `BadOrigin`, and the referendum is unchanged
 */
export async function cancelByRejectedOrigins(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_cancel_rejected`)

  // 1. Submit a referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} cancel rejected`)
  const statusBefore = (await ongoingStatus(client, cfg, index)).toHex()

  // 2. and 3. Injected cancels with rejected origins

  await scheduleCallListWithOrigin(
    client,
    cfg.cancelOrigins.rejected.map((origin) => ({
      call: { Inline: referenda.tx.cancel(index).method.toHex() },
      origin,
    })),
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('cancel by rejected origins: Dispatched')
  const results = await dispatchedResults(client)
  expect(results).toHaveLength(cfg.cancelOrigins.rejected.length)
  for (const result of results) {
    expect(result.isErr && result.asErr.isBadOrigin, `cancel dispatched with ${result.toString()}`).toBe(true)
  }

  // 4. and 5. A signed cancel, and the referendum is unchanged

  await sendTransaction(referenda.tx.cancel(index).signAsync(submitter))
  await client.dev.newBlock()
  await expectExtrinsicBadOrigin(client)
  expect((await ongoingStatus(client, cfg, index)).toHex()).toBe(statusBefore)
}

/**
 * Each origin the instance's `KillOrigin` accepts can kill an ongoing referendum. Killing slashes
 * both deposits and clears the referendum's metadata.
 *
 * The submission deposit is zero on these runtimes, so its `DepositSlashed` carries a zero amount.
 * The slashed decision deposit goes to the runtime's slash destination: on the Collectives chain it
 * is teleported to the relay chain's treasury account; on the Kusama relay it is paid into the
 * treasury pot.
 *
 * 1. Seed a submitter; per accepted origin, submit a referendum, have a non-member pay its decision
 *    deposit, and set its metadata
 * 2. Inject one `kill` per referendum, each with its own accepted origin
 * 3. Check every injected call dispatched, and each referendum emits `Killed`, `DepositSlashed` for
 *    both deposits, and `MetadataCleared`
 * 4. Check each referendum is stored as killed in this block with no metadata, and each payer's
 *    reserve lost the deposit while its free balance is unchanged
 * 5. Check the slashed deposits reached the slash destination
 */
export async function killByAcceptedOrigins(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_kill_submitter`)
  const payers = cfg.killOrigins.accepted.map((_, i) => keyring.addFromUri(`//${cfg.referenda}_kill_payer_${i}`))
  const deposit = trackInfo(client, cfg, cfg.track.id).decisionDeposit.toBigInt()

  // 1. One referendum per accepted origin, each holding a decision deposit and metadata

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, payers, endowment(client, cfg))
  const indices = await submitWithDeposits(client, cfg, submitter, payers, `${cfg.referenda} kill`)
  // Named by position in this test, not by referendum index, so the hash does not depend on how many
  // referenda the live chain already holds.
  const metadata = indices.map((_, i) => stringToHex(`${cfg.referenda} kill metadata ${i}`))
  await sendTransaction(
    client.api.tx.utility
      .batchAll(
        indices.flatMap((index, i) => [
          client.api.tx.preimage.notePreimage(metadata[i]),
          referenda.tx.setMetadata(index, blake2AsHex(metadata[i])),
        ]),
      )
      .signAsync(submitter),
  )
  await client.dev.newBlock()
  for (const index of indices) {
    assert((await referenda.query.metadataOf(index)).isSome, `setup metadata on ${index} should be set`)
  }
  const balancesBefore = await Promise.all(
    payers.map(async (payer) => (await client.api.query.system.account(payer.address)).data),
  )
  const potBefore =
    cfg.slashDestination === 'treasury'
      ? (await client.api.query.system.account(client.api.consts.treasury.potAccount)).data.free.toBigInt()
      : 0n

  // 2. Inject the kills

  await scheduleCallListWithOrigin(
    client,
    indices.map((index, i) => ({
      call: { Inline: referenda.tx.kill(index).method.toHex() },
      origin: cfg.killOrigins.accepted[i],
    })),
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  const killedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 3. Every kill dispatched; `Killed`, both `DepositSlashed`, and `MetadataCleared` per referendum

  await checkSystemEvents(client, cfg.referenda, { section: 'scheduler', method: 'Dispatched' })
    .redact({ hash: false, redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('kill by accepted origins: Dispatched and referenda events')
  expect((await dispatchedResults(client)).map((result) => result.isOk)).toEqual(indices.map(() => true))
  const events = (await client.api.query.system.events()).map(({ event }) => event)
  const killed = events.filter((event) => referenda.events.Killed.is(event)).map((event) => event.data as any)
  expect(killed.map((data) => data.index.toNumber())).toEqual(indices)
  const slashed = events
    .filter((event) => referenda.events.DepositSlashed.is(event))
    .map((event) => [(event.data as any).who.toHex(), (event.data as any).amount.toBigInt()])
  expect(slashed).toEqual(
    indices.flatMap((_, i) => [
      [u8aToHex(submitter.publicKey), referenda.consts.submissionDeposit.toBigInt()],
      [u8aToHex(payers[i].publicKey), deposit],
    ]),
  )
  expect(await metadataEvents(client, cfg, 'MetadataCleared')).toEqual(
    indices.map((index, i) => [index, blake2AsHex(metadata[i])]),
  )

  // 4. Stored as killed, metadata gone, and each payer's deposit taken from its reserve

  for (const [i, index] of indices.entries()) {
    const info = await referenda.query.referendumInfoFor(index)
    assert(info.isSome && info.unwrap().isKilled, `referendum ${index} should be killed`)
    expect(info.unwrap().asKilled.toNumber()).toBe(killedAt)
    expect((await referenda.query.metadataOf(index)).isNone).toBe(true)
    const after = (await client.api.query.system.account(payers[i].address)).data
    expect(balancesBefore[i].reserved.toBigInt() - after.reserved.toBigInt()).toBe(deposit)
    expect(after.free.toBigInt()).toBe(balancesBefore[i].free.toBigInt())
  }

  // 5. The slashed deposits reached the slash destination

  if (cfg.slashDestination === 'treasury') {
    const deposits = events
      .filter((event) => client.api.events.treasury.Deposit.is(event))
      .map((event) => (event.data as any).value.toBigInt())
    expect(deposits).toEqual(indices.map(() => deposit))
    const potAfter = (await client.api.query.system.account(client.api.consts.treasury.potAccount)).data.free.toBigInt()
    expect(potAfter - potBefore).toBe(deposits.reduce((sum, value) => sum + value, 0n))
  } else {
    await checkSystemEvents(client, 'polkadotXcm')
      .redact({ hash: false, redactKeys: /^messageId$/ })
      .toMatchSnapshot('kill by accepted origins: slashed deposits teleported to the relay treasury')
    // `polkadotXcm` is not in the PJS type augmentation PET loads, so its event data is untyped.
    const attempted = events
      .filter((event) => client.api.events.polkadotXcm.Attempted.is(event))
      .map((event) => event.data as any)
    expect(attempted).toHaveLength(indices.length)
    for (const data of attempted) {
      expect(data.outcome.isComplete, `teleport outcome ${data.outcome.type}`).toBe(true)
    }
    const sent = events
      .filter((event) => client.api.events.polkadotXcm.Sent.is(event))
      .map((event) => event.data as any)
    expect(sent).toHaveLength(indices.length)
    // The relay chain treasury's pallet account: `modl` and the pallet id `py/trsry`, padded with
    // zeros to 32 bytes.
    const relayTreasury = u8aToHex(u8aConcat(stringToU8a('modlpy/trsry'), new Uint8Array(20)))
    for (const data of sent) {
      expect(data.destination.toJSON()).toEqual({ parents: 1, interior: { here: null } })
      // The message receives the teleported deposit, then deposits it to the relay treasury.
      const instructions = [...data.message]
      expect(instructions[0].asReceiveTeleportedAsset[0].fun.asFungible.toBigInt()).toBe(deposit)
      const beneficiary = instructions[instructions.length - 1].asDepositAsset.beneficiary
      expect(beneficiary.interior.asX1[0].asAccountId32.id.toHex()).toBe(relayTreasury)
    }
  }
}

/**
 * Origins outside the instance's `KillOrigin` cannot kill a referendum: each injected kill fails
 * with `BadOrigin`, and so does a kill signed by the referendum's own submitter.
 *
 * 1. Seed a submitter and submit a referendum
 * 2. Inject one `kill` per rejected origin into the same block
 * 3. Check each dispatched with `BadOrigin`
 * 4. The submitter signs a `kill`
 * 5. Check it fails with `BadOrigin`, and the referendum is unchanged
 */
export async function killByRejectedOrigins(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_kill_rejected`)

  // 1. Submit a referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} kill rejected`)
  const statusBefore = (await ongoingStatus(client, cfg, index)).toHex()

  // 2. and 3. Injected kills with rejected origins

  await scheduleCallListWithOrigin(
    client,
    cfg.killOrigins.rejected.map((origin) => ({ call: { Inline: referenda.tx.kill(index).method.toHex() }, origin })),
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('kill by rejected origins: Dispatched')
  const results = await dispatchedResults(client)
  expect(results).toHaveLength(cfg.killOrigins.rejected.length)
  for (const result of results) {
    expect(result.isErr && result.asErr.isBadOrigin, `kill dispatched with ${result.toString()}`).toBe(true)
  }

  // 4. and 5. A signed kill, and the referendum is unchanged

  await sendTransaction(referenda.tx.kill(index).signAsync(submitter))
  await client.dev.newBlock()
  await expectExtrinsicBadOrigin(client)
  expect((await ongoingStatus(client, cfg, index)).toHex()).toBe(statusBefore)
}

/**
 * Cancelling a deciding referendum frees its deciding slot one block later, through a
 * `oneFewerDeciding` alarm. Cancelling a referendum that never started deciding schedules no such
 * alarm, so the track's deciding count is not decremented twice.
 *
 * Track 21 (`PromoteTo1Dan`) has no prepare period, so a decision deposit starts the decision
 * straight away.
 *
 * 1. Seed a submitter and a payer, and record the track's deciding count
 * 2. Submit two referenda; the payer places a deposit on the first only, which starts deciding
 * 3. Inject a `cancel` for both into the same block
 * 4. Check both are cancelled, and the next block's agenda holds exactly one `oneFewerDeciding`
 *    for the track
 * 5. Build that block, and check the deciding count is back to where it started
 */
export async function cancelFreesOnlyDecidingSlot(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_slot_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_slot_payer`)
  const track: RankedReferendaTrack = { id: 21, origin: { FellowshipOrigins: 'PromoteTo1Dan' } }
  expect(trackInfo(client, cfg, track.id).preparePeriod.toNumber()).toBe(0)

  // 1. Seed, fund, and record the deciding count

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const decidingCountBefore = (await referenda.query.decidingCount(track.id)).toNumber()

  // 2. One deciding referendum, one without a deposit

  const deciding = await submitReferendum(client, cfg, submitter, track, `${cfg.referenda} slot deciding`)
  const idle = await submitReferendum(client, cfg, submitter, track, `${cfg.referenda} slot idle`)
  await sendTransaction(referenda.tx.placeDecisionDeposit(deciding).signAsync(payer))
  await client.dev.newBlock()
  expect((await ongoingStatus(client, cfg, deciding)).deciding.isSome).toBe(true)
  expect((await ongoingStatus(client, cfg, idle)).deciding.isNone).toBe(true)
  expect((await referenda.query.decidingCount(track.id)).toNumber()).toBe(decidingCountBefore + 1)

  // 3. Cancel both in one block

  await scheduleCallListWithOrigin(
    client,
    [deciding, idle].map((index) => ({
      call: { Inline: referenda.tx.cancel(index).method.toHex() },
      origin: cfg.cancelOrigins.accepted[0],
    })),
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. Both cancelled, and exactly one `oneFewerDeciding` alarm for the next block

  expect((await dispatchedResults(client)).map((result) => result.isOk)).toEqual([true, true])
  const cancelled = (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => referenda.events.Cancelled.is(event))
    .map((event) => (event.data as any).index.toNumber())
  expect(cancelled).toEqual([deciding, idle])

  const nextBlock = (await client.api.rpc.chain.getHeader()).number.toNumber() + 1
  const oneFewer = referenda.tx.oneFewerDeciding(track.id).method.toHex()
  const alarms = [...(await client.api.query.scheduler.agenda(nextBlock))].filter(
    (task: any) => task.isSome && task.unwrap().call.isInline && task.unwrap().call.asInline.toHex() === oneFewer,
  )
  expect(alarms, 'only the deciding referendum should free a slot').toHaveLength(1)

  // 5. The alarm runs, and the deciding count is restored

  await client.dev.newBlock()
  expect((await referenda.query.decidingCount(track.id)).toNumber()).toBe(decidingCountBefore)
}

/**
 * A referendum that has already ended cannot be cancelled or killed again: both fail with
 * `NotOngoing`, and the stored outcome is unchanged.
 *
 * 1. Seed a submitter, submit a referendum, and cancel it with an accepted origin
 * 2. Inject a second `cancel` and a `kill`, each with an origin its check accepts
 * 3. Check both dispatched with `NotOngoing`, and the referendum is still stored as cancelled at
 *    the same block
 */
export async function cancelOrKillFinished(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_finished_submitter`)

  // 1. Submit and cancel a referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} finished`)
  await scheduleInlineCallWithOrigin(
    client,
    referenda.tx.cancel(index).method.toHex(),
    cfg.cancelOrigins.accepted[0],
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  expect(
    (await dispatchedResults(client)).map((result) => result.isOk),
    'the setup cancel should dispatch',
  ).toEqual([true])
  const infoBefore = (await referenda.query.referendumInfoFor(index)).toHex()

  // 2. Cancel and kill again

  await scheduleCallListWithOrigin(
    client,
    [
      { call: { Inline: referenda.tx.cancel(index).method.toHex() }, origin: cfg.cancelOrigins.accepted[0] },
      { call: { Inline: referenda.tx.kill(index).method.toHex() }, origin: cfg.killOrigins.accepted[0] },
    ],
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Both `NotOngoing`, and the stored outcome is unchanged

  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('cancel and kill a finished referendum: Dispatched')
  const results = await dispatchedResults(client)
  expect(results).toHaveLength(2)
  for (const result of results) {
    assert(result.isErr && result.asErr.isModule, `expected a module error, got ${result.toString()}`)
    expect(referenda.errors.NotOngoing.is(result.asErr.asModule)).toBe(true)
  }
  expect((await referenda.query.referendumInfoFor(index)).toHex()).toBe(infoBefore)
}

/**
 * The scheduler task name `pallet-referenda` gives a referendum's enactment: the `blake2_256` of
 * the SCALE-encoded tuple `(*b"assembly", "enactment", index)`, that is the eight raw bytes
 * `assembly`, the length-prefixed string `enactment`, and the index as a `u32`.
 */
function enactmentTaskName(client: Client<any, any>, index: number): HexString {
  return blake2AsHex(
    u8aConcat(
      stringToU8a('assembly'),
      client.api.createType('Text', 'enactment').toU8a(),
      client.api.createType('u32', index).toU8a(),
    ),
  )
}

/**
 * A real `Architects` referendum on the Collectives Fellowship can cancel another referendum.
 * This drives the origin through its real source: a referendum on track 4 enacts its proposal
 * with the `Architects` origin, which is the Fellowship's `CancelOrigin`.
 *
 * The cancelling referendum is run by `passFellowshipReferendum`: a seeded rank-4 member submits
 * and votes for real, and only the referendum's clock is moved forward.
 *
 * 1. Seed a submitter and submit the target referendum
 * 2. Seed a rank-4 member, the minimum rank that may vote on track 4
 * 3. Pass an `Architects` referendum whose proposal cancels the target, and enact it
 * 4. Check the enactment task dispatched, and the target emits `Cancelled`
 * 5. Check the target is stored as cancelled
 */
export async function cancelByRealArchitectsReferendum(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_real_cancel_target`)
  const architect = keyring.addFromUri(`//${cfg.referenda}_real_cancel_architect`)

  // 1. The target referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const target = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} real cancel target`)

  // 2. A rank-4 member to submit and vote on track 4

  await seedRankedMembers(client, cfg, [{ pair: architect, rank: 4 }], endowment(client, cfg))

  // 3. Pass and enact the cancelling referendum

  const architectsReferendum = await passFellowshipReferendum(client, referenda.tx.cancel(target), {
    track: { FellowshipOrigins: 'Architects' },
    voters: [architect],
  })

  // 4. The enactment dispatched, and the target is cancelled

  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: cfg.referenda, method: 'Cancelled' },
  )
    .redact({ redactKeys: /^(index|task|id)$/ })
    .toMatchSnapshot('real Architects referendum: enactment and Cancelled')
  const events = (await client.api.query.system.events()).map(({ event }) => event)
  const enactment = events.filter(
    (event) =>
      client.api.events.scheduler.Dispatched.is(event) &&
      event.data.id.isSome &&
      event.data.id.unwrap().toHex() === enactmentTaskName(client, architectsReferendum),
  )
  expect(enactment).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(enactment[0]))
  expect(enactment[0].data.result.isOk, `enactment dispatched with ${enactment[0].data.result.toString()}`).toBe(true)
  const cancelled = events
    .filter((event) => referenda.events.Cancelled.is(event))
    .map((event) => (event.data as any).index.toNumber())
  expect(cancelled).toEqual([target])

  // 5. The target is stored as cancelled

  const info = await referenda.query.referendumInfoFor(target)
  assert(info.isSome && info.unwrap().isCancelled, `referendum ${target} should be cancelled`)
}

/**
 * The encoded calls of every `Transact` in the `polkadotXcm.Sent` events of the head block.
 * `polkadotXcm` is not in the PJS type augmentation PET loads, so its event data is untyped.
 */
async function sentTransactCalls(client: Client<any, any>): Promise<HexString[]> {
  return (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => client.api.events.polkadotXcm.Sent.is(event))
    .flatMap((event) => [...(event.data as any).message])
    .filter((instruction: any) => instruction.isTransact)
    .map((instruction: any) => instruction.asTransact.call.encoded.toHex())
}

/**
 * The Ambassador referenda `CancelOrigin` includes the `FellowshipAdmin` voice of Asset Hub, so
 * Polkadot OpenGov on Asset Hub can cancel an Ambassador referendum over XCM.
 *
 * On Asset Hub the `FellowshipAdmin` origin is injected (setup); it sends a `Transact` with origin
 * kind `Xcm`, so the Collectives chain dispatches `cancel` with the location
 * `../Parachain(1000)/Plurality(FellowshipAdmin, Voice)`. The Collectives side is real XCM.
 *
 * 1. Seed a submitter and submit an Ambassador referendum
 * 2. On Asset Hub, inject `polkadotXcm.send` with the `FellowshipAdmin` origin, carrying
 *    `ambassadorReferenda.cancel` to the Collectives chain
 * 3. Check the send dispatched, Asset Hub emits `Sent`, and its `Transact` carries the `cancel`
 * 4. On the Collectives chain, check the message is processed successfully and the referendum
 *    emits `Cancelled`
 * 5. Check the referendum is stored as cancelled
 */
export async function cancelByAssetHubFellowshipAdmin(
  assetHubClient: Client<any, any>,
  collectivesClient: Client<any, any>,
  cfg: RankedReferendaTestConfig,
) {
  const referenda = instance(collectivesClient, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_xcm_cancel_submitter`)

  // 1. Submit an Ambassador referendum

  await seedRankedMembers(
    collectivesClient,
    cfg,
    [{ pair: submitter, rank: cfg.submitAnyTrack.rank }],
    endowment(collectivesClient, cfg),
  )
  const index = await submitReferendum(collectivesClient, cfg, submitter, cfg.track, `${cfg.referenda} xcm cancel`)

  // 2. Send the cancel from Asset Hub as `FellowshipAdmin`

  const send = createXcmTransactSend(
    assetHubClient,
    getXcmRoute(assetHubClient.config, collectivesClient.config),
    referenda.tx.cancel(index).method.toHex(),
    'Xcm',
  )
  await scheduleInlineCallWithOrigin(
    assetHubClient,
    send.method.toHex(),
    { Origins: 'FellowshipAdmin' },
    assetHubClient.config.properties.schedulerBlockProvider,
  )
  await assetHubClient.dev.newBlock()

  // 3. Dispatched on Asset Hub, and `Sent` carrying the `cancel`

  // The encoded call holds the referendum index, which depends on how many referenda the live
  // chain holds, so the snapshot redacts it and the typed check below pins it instead.
  await checkSystemEvents(assetHubClient, { section: 'polkadotXcm', method: 'Sent' })
    .redact({ hash: false, redactKeys: /^(messageId|encoded)$/ })
    .toMatchSnapshot('cancel over XCM: Asset Hub sends')
  expect(
    (await dispatchedResults(assetHubClient)).map((result) => result.isOk),
    'the FellowshipAdmin send should dispatch',
  ).toEqual([true])
  expect(await sentTransactCalls(assetHubClient)).toEqual([referenda.tx.cancel(index).method.toHex()])

  // 4. Processed on the Collectives chain, and `Cancelled`

  await collectivesClient.dev.newBlock()
  await checkSystemEvents(
    collectivesClient,
    { section: 'messageQueue', method: 'Processed' },
    { section: cfg.referenda, method: 'Cancelled' },
  )
    .redact({ hash: false, redactKeys: /^(id|index|origin)$/ })
    .toMatchSnapshot('cancel over XCM: Collectives processes and cancels')
  const events = (await collectivesClient.api.query.system.events()).map(({ event }) => event)
  const processed = events.filter((event) => collectivesClient.api.events.messageQueue.Processed.is(event))
  expect(processed.length).toBeGreaterThan(0)
  for (const event of processed) {
    assert(collectivesClient.api.events.messageQueue.Processed.is(event))
    expect(event.data.success.isTrue, 'the cancel message should process successfully').toBe(true)
  }
  const cancelled = events
    .filter((event) => referenda.events.Cancelled.is(event))
    .map((event) => (event.data as any).index.toNumber())
  expect(cancelled).toEqual([index])

  // 5. Stored as cancelled

  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isCancelled, `referendum ${index} should be cancelled`)
}

/**
 * The Ambassador referenda `KillOrigin` also includes the `FellowshipAdmin` voice of Asset Hub, so
 * Polkadot OpenGov on Asset Hub can kill an Ambassador referendum over XCM, slashing its deposits.
 *
 * As for the cancel, the `FellowshipAdmin` origin is injected on Asset Hub (setup), and the
 * Collectives side is real XCM. The referendum holds only its submission deposit, which is zero on
 * this runtime, so the kill slashes a zero amount from the submitter.
 *
 * 1. Seed a submitter and submit an Ambassador referendum
 * 2. On Asset Hub, inject `polkadotXcm.send` with the `FellowshipAdmin` origin, carrying
 *    `ambassadorReferenda.kill` to the Collectives chain
 * 3. Check the send dispatched, Asset Hub emits `Sent`, and its `Transact` carries the `kill`
 * 4. On the Collectives chain, check the message is processed successfully, and the referendum
 *    emits `Killed` and `DepositSlashed` for the submission deposit
 * 5. Check the referendum is stored as killed in that block
 */
export async function killByAssetHubFellowshipAdmin(
  assetHubClient: Client<any, any>,
  collectivesClient: Client<any, any>,
  cfg: RankedReferendaTestConfig,
) {
  const referenda = instance(collectivesClient, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_xcm_kill_submitter`)

  // 1. Submit an Ambassador referendum

  await seedRankedMembers(
    collectivesClient,
    cfg,
    [{ pair: submitter, rank: cfg.submitAnyTrack.rank }],
    endowment(collectivesClient, cfg),
  )
  const index = await submitReferendum(collectivesClient, cfg, submitter, cfg.track, `${cfg.referenda} xcm kill`)

  // 2. Send the kill from Asset Hub as `FellowshipAdmin`

  const send = createXcmTransactSend(
    assetHubClient,
    getXcmRoute(assetHubClient.config, collectivesClient.config),
    referenda.tx.kill(index).method.toHex(),
    'Xcm',
  )
  await scheduleInlineCallWithOrigin(
    assetHubClient,
    send.method.toHex(),
    { Origins: 'FellowshipAdmin' },
    assetHubClient.config.properties.schedulerBlockProvider,
  )
  await assetHubClient.dev.newBlock()

  // 3. Dispatched on Asset Hub, and `Sent` carrying the `kill`

  // The encoded call holds the live referendum index, so the snapshot redacts it and the typed
  // check below pins it instead.
  await checkSystemEvents(assetHubClient, { section: 'polkadotXcm', method: 'Sent' })
    .redact({ hash: false, redactKeys: /^(messageId|encoded)$/ })
    .toMatchSnapshot('kill over XCM: Asset Hub sends')
  expect(
    (await dispatchedResults(assetHubClient)).map((result) => result.isOk),
    'the FellowshipAdmin send should dispatch',
  ).toEqual([true])
  expect(await sentTransactCalls(assetHubClient)).toEqual([referenda.tx.kill(index).method.toHex()])

  // 4. Processed on the Collectives chain; `Killed` and the slashed submission deposit

  await collectivesClient.dev.newBlock()
  const killedAt = (await collectivesClient.api.rpc.chain.getHeader()).number.toNumber()
  await checkSystemEvents(collectivesClient, { section: 'messageQueue', method: 'Processed' }, cfg.referenda)
    .redact({ hash: false, redactKeys: /^(id|index|origin)$/ })
    .toMatchSnapshot('kill over XCM: Collectives processes and kills')
  const events = (await collectivesClient.api.query.system.events()).map(({ event }) => event)
  const processed = events.filter((event) => collectivesClient.api.events.messageQueue.Processed.is(event))
  expect(processed.length).toBeGreaterThan(0)
  for (const event of processed) {
    assert(collectivesClient.api.events.messageQueue.Processed.is(event))
    expect(event.data.success.isTrue, 'the kill message should process successfully').toBe(true)
  }
  expect(await referendumEvents(collectivesClient, cfg, 'Killed', index)).toHaveLength(1)
  const slashed = events
    .filter((event) => referenda.events.DepositSlashed.is(event))
    .map((event) => [(event.data as any).who.toHex(), (event.data as any).amount.toBigInt()])
  expect(slashed).toEqual([[u8aToHex(submitter.publicKey), referenda.consts.submissionDeposit.toBigInt()]])

  // 5. Stored as killed

  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isKilled, `referendum ${index} should be killed`)
  expect(info.unwrap().asKilled.toNumber()).toBe(killedAt)
}

/// -------
/// Refunds
/// -------

/**
 * Inject `calls` into the next block with their origins, build it, and check every call
 * dispatched. Setup for tests that need a referendum cancelled or killed before the step under
 * test.
 */
async function dispatchSetupCalls(
  client: Client<any, any>,
  calls: { call: { method: { toHex: () => HexString } }; origin: DispatchOrigin }[],
): Promise<void> {
  await scheduleCallListWithOrigin(
    client,
    calls.map(({ call, origin }) => ({ call: { Inline: call.method.toHex() }, origin })),
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  expect(
    (await dispatchedResults(client)).map((result) => result.isOk),
    'every setup call should dispatch',
  ).toEqual(calls.map(() => true))
}

/**
 * After a referendum is cancelled, anyone may trigger both refunds. Each deposit returns to the
 * account that placed it, not to the caller. The submission deposit is zero on these runtimes, so
 * its refund carries a zero amount.
 *
 * 1. Seed a submitter, fund a payer and a non-member refunder; submit, place the deposit, and
 *    cancel the referendum
 * 2. The refunder batches `refundDecisionDeposit` and `refundSubmissionDeposit`
 * 3. Check `DecisionDepositRefunded` names the payer and the deposit, and
 *    `SubmissionDepositRefunded` names the submitter and `SubmissionDeposit`
 * 4. Check the payer's deposit moved from reserved back to free, and the refunder paid only the fee
 * 5. Check the referendum is still cancelled at the same block, now holding neither deposit
 */
export async function refundsAfterCancel(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_refund_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_refund_payer`)
  const refunder = keyring.addFromUri(`//${cfg.referenda}_refund_caller`)
  const deposit = trackInfo(client, cfg, cfg.track.id).decisionDeposit.toBigInt()

  // 1. Submit, place the deposit, and cancel

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer, refunder], endowment(client, cfg))
  const [index] = await submitWithDeposits(client, cfg, submitter, [payer], `${cfg.referenda} refund`)
  await dispatchSetupCalls(client, [{ call: referenda.tx.cancel(index), origin: cfg.cancelOrigins.accepted[0] }])
  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isCancelled, `referendum ${index} should be cancelled`)
  const cancelledAt = info.unwrap().asCancelled[0].toNumber()
  const payerBefore = (await client.api.query.system.account(payer.address)).data
  const refunderBefore = (await client.api.query.system.account(refunder.address)).data

  // 2. A third party refunds both deposits

  await sendTransaction(
    client.api.tx.utility
      .batchAll([referenda.tx.refundDecisionDeposit(index), referenda.tx.refundSubmissionDeposit(index)])
      .signAsync(refunder),
  )
  await client.dev.newBlock()

  // 3. Both refund events name the depositors

  await checkSystemEvents(
    client,
    { section: cfg.referenda, method: 'DecisionDepositRefunded' },
    { section: cfg.referenda, method: 'SubmissionDepositRefunded' },
  )
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('refunds after cancel: both deposits refunded')
  const events = (await client.api.query.system.events()).map(({ event }) => event)
  const decisionRefunds = events
    .filter((event) => referenda.events.DecisionDepositRefunded.is(event))
    .map((event) => event.data as any)
  expect(decisionRefunds.map((data) => [data.index.toNumber(), data.who.toHex(), data.amount.toBigInt()])).toEqual([
    [index, u8aToHex(payer.publicKey), deposit],
  ])
  const submissionRefunds = events
    .filter((event) => referenda.events.SubmissionDepositRefunded.is(event))
    .map((event) => event.data as any)
  expect(submissionRefunds.map((data) => [data.index.toNumber(), data.who.toHex(), data.amount.toBigInt()])).toEqual([
    [index, u8aToHex(submitter.publicKey), referenda.consts.submissionDeposit.toBigInt()],
  ])

  // 4. The payer gets the deposit back; the refunder only pays the fee

  const payerAfter = (await client.api.query.system.account(payer.address)).data
  expect(payerBefore.reserved.toBigInt() - payerAfter.reserved.toBigInt()).toBe(deposit)
  expect(payerAfter.free.toBigInt() - payerBefore.free.toBigInt()).toBe(deposit)
  const fee = await feePaidBy(client, refunder)
  const refunderAfter = (await client.api.query.system.account(refunder.address)).data
  expect(refunderBefore.free.toBigInt() - refunderAfter.free.toBigInt()).toBe(fee)
  expect(refunderAfter.reserved.toBigInt()).toBe(refunderBefore.reserved.toBigInt())

  // 5. Still cancelled, now holding neither deposit

  const after = await referenda.query.referendumInfoFor(index)
  assert(after.isSome && after.unwrap().isCancelled, `referendum ${index} should still be cancelled`)
  const [moment, submission, decision] = after.unwrap().asCancelled
  expect(moment.toNumber()).toBe(cancelledAt)
  expect(submission.isNone).toBe(true)
  expect(decision.isNone).toBe(true)
}

/**
 * A decision deposit cannot be refunded while its referendum is still ongoing: the refund fails
 * with `Unfinished`, and the deposit stays reserved.
 *
 * 1. Seed a submitter, fund a payer, submit, and place the deposit
 * 2. The payer asks for the decision deposit back
 * 3. Check it fails with `Unfinished`, and the deposit is still recorded and reserved
 */
export async function refundDecisionDepositOngoing(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_unfinished_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_unfinished_payer`)

  // 1. An ongoing referendum holding a decision deposit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const [index] = await submitWithDeposits(client, cfg, submitter, [payer], `${cfg.referenda} unfinished`)
  const reservedBefore = (await client.api.query.system.account(payer.address)).data.reserved.toBigInt()

  // 2. Ask for the deposit back

  await sendTransaction(referenda.tx.refundDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()

  // 3. `Unfinished`, and the deposit stays

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund decision deposit while ongoing: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'Unfinished')
  expect((await ongoingStatus(client, cfg, index)).decisionDeposit.isSome).toBe(true)
  expect((await client.api.query.system.account(payer.address)).data.reserved.toBigInt()).toBe(reservedBefore)
}

/**
 * A decision deposit that is already refunded, or was slashed by a kill, cannot be refunded: both
 * fail with `NoDeposit`.
 *
 * 1. Seed a submitter, fund two payers, and open two referenda holding a decision deposit each
 * 2. Cancel the first and kill the second, then refund the first referendum's decision deposit
 * 3. Ask for the first referendum's decision deposit again, and check it fails with `NoDeposit`
 * 4. Ask for the killed referendum's decision deposit, and check it fails with `NoDeposit`
 * 5. Check neither payer's balance changed during the failed refunds
 */
export async function refundDecisionDepositNothingLeft(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_nothing_left_submitter`)
  const payers = [0, 1].map((i) => keyring.addFromUri(`//${cfg.referenda}_nothing_left_payer_${i}`))

  // 1. Two referenda, each holding a decision deposit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, payers, endowment(client, cfg))
  const [refunded, killed] = await submitWithDeposits(client, cfg, submitter, payers, `${cfg.referenda} nothing left`)

  // 2. Cancel the first and kill the second; refund the first

  await dispatchSetupCalls(client, [
    { call: referenda.tx.cancel(refunded), origin: cfg.cancelOrigins.accepted[0] },
    { call: referenda.tx.kill(killed), origin: cfg.killOrigins.accepted[0] },
  ])
  await sendTransaction(referenda.tx.refundDecisionDeposit(refunded).signAsync(payers[0]))
  await client.dev.newBlock()
  const firstRefund = (await client.api.query.system.events()).filter(({ event }) =>
    referenda.events.DecisionDepositRefunded.is(event),
  )
  expect(firstRefund, 'the setup refund should succeed').toHaveLength(1)
  const balancesBefore = await Promise.all(
    payers.map(async (payer) => (await client.api.query.system.account(payer.address)).data),
  )

  // 3. Refund the refunded deposit again

  await sendTransaction(referenda.tx.refundDecisionDeposit(refunded).signAsync(payers[1]))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund decision deposit twice: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NoDeposit')

  // 4. Refund the killed referendum's deposit

  await sendTransaction(referenda.tx.refundDecisionDeposit(killed).signAsync(payers[0]))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund decision deposit of a killed referendum: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NoDeposit')

  // 5. Reserves unchanged by the failed refunds

  for (const [i, payer] of payers.entries()) {
    const after = (await client.api.query.system.account(payer.address)).data
    expect(after.reserved.toBigInt()).toBe(balancesBefore[i].reserved.toBigInt())
  }
}

/**
 * Both refunds reject an index that was never used, with `BadReferendum`.
 *
 * 1. Fund a caller and pick an index past `ReferendumCount`
 * 2. Ask for its decision deposit, and check it fails with `BadReferendum`
 * 3. Ask for its submission deposit, and check it fails with `BadReferendum`
 */
export async function refundsUnknownReferendum(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const caller = keyring.addFromUri(`//${cfg.referenda}_unknown_refund`)

  // 1. An index that was never used

  await fundAccounts(client, [caller], endowment(client, cfg))
  const unusedIndex = (await referenda.query.referendumCount()).toNumber() + 1000
  expect((await referenda.query.referendumInfoFor(unusedIndex)).isNone).toBe(true)

  // 2. Decision deposit

  await sendTransaction(referenda.tx.refundDecisionDeposit(unusedIndex).signAsync(caller))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund decision deposit of an unused index: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'BadReferendum')

  // 3. Submission deposit

  await sendTransaction(referenda.tx.refundSubmissionDeposit(unusedIndex).signAsync(caller))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund submission deposit of an unused index: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'BadReferendum')
}

/**
 * A submission deposit is refundable only once a referendum is approved or cancelled. While it is
 * ongoing, or after it was killed, the refund fails with `BadStatus`.
 *
 * 1. Seed a submitter and open two referenda; kill the second
 * 2. Ask for the ongoing referendum's submission deposit, and check it fails with `BadStatus`
 * 3. Ask for the killed referendum's submission deposit, and check it fails with `BadStatus`
 * 4. Check the ongoing referendum still holds its submission deposit record
 */
export async function refundSubmissionDepositBadStatus(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_bad_status_submitter`)

  // 1. One ongoing and one killed referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const ongoing = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} bad status ongoing`)
  const killed = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} bad status killed`)
  await dispatchSetupCalls(client, [{ call: referenda.tx.kill(killed), origin: cfg.killOrigins.accepted[0] }])

  // 2. The ongoing referendum

  await sendTransaction(referenda.tx.refundSubmissionDeposit(ongoing).signAsync(submitter))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund submission deposit while ongoing: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'BadStatus')

  // 3. The killed referendum

  await sendTransaction(referenda.tx.refundSubmissionDeposit(killed).signAsync(submitter))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'refund submission deposit of a killed referendum: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'BadStatus')

  // 4. The ongoing referendum keeps its deposit record

  expect((await ongoingStatus(client, cfg, ongoing)).submissionDeposit.who.toHex()).toBe(u8aToHex(submitter.publicKey))
}

/**
 * Both refunds accept a signed or a `Root` origin, and nothing else. On the Collectives Fellowship
 * the collective's own `Fellows` origin is neither, so its refunds fail with `BadOrigin`, while the
 * same refunds dispatched as `Root` succeed.
 *
 * 1. Seed a submitter, fund a payer, submit, place the deposit, and cancel the referendum
 * 2. Inject both refunds with the `Fellows` origin, then both with `Root`, into one block
 * 3. Check the `Fellows` refunds dispatched with `BadOrigin` and the `Root` refunds succeeded
 * 4. Check each deposit was refunded exactly once, to its depositor
 */
export async function refundsByRootAndCollectiveOrigin(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_root_refund_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_root_refund_payer`)
  const deposit = trackInfo(client, cfg, cfg.track.id).decisionDeposit.toBigInt()

  // 1. A cancelled referendum holding both deposits

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const [index] = await submitWithDeposits(client, cfg, submitter, [payer], `${cfg.referenda} root refund`)
  await dispatchSetupCalls(client, [{ call: referenda.tx.cancel(index), origin: cfg.cancelOrigins.accepted[0] }])
  const reservedBefore = (await client.api.query.system.account(payer.address)).data.reserved.toBigInt()

  // 2. Both refunds with `Fellows`, then with `Root`

  const refunds = [referenda.tx.refundDecisionDeposit(index), referenda.tx.refundSubmissionDeposit(index)]
  await scheduleCallListWithOrigin(
    client,
    [
      ...refunds.map((call) => ({ call: { Inline: call.method.toHex() }, origin: { FellowshipOrigins: 'Fellows' } })),
      ...refunds.map((call) => ({ call: { Inline: call.method.toHex() }, origin: { system: 'Root' } })),
    ],
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `Fellows` is rejected, `Root` succeeds

  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: cfg.referenda, method: 'DecisionDepositRefunded' },
    { section: cfg.referenda, method: 'SubmissionDepositRefunded' },
  )
    .redact({ redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('refunds by Fellows and Root: Dispatched and refunds')
  const results = await dispatchedResults(client)
  expect(results.map((result) => (result.isOk ? 'Ok' : result.asErr.isBadOrigin ? 'BadOrigin' : 'other'))).toEqual([
    'BadOrigin',
    'BadOrigin',
    'Ok',
    'Ok',
  ])

  // 4. Each deposit refunded once, to its depositor

  const events = (await client.api.query.system.events()).map(({ event }) => event)
  const decisionRefunds = events.filter((event) => referenda.events.DecisionDepositRefunded.is(event))
  expect(decisionRefunds.map((event) => (event.data as any).who.toHex())).toEqual([u8aToHex(payer.publicKey)])
  const submissionRefunds = events.filter((event) => referenda.events.SubmissionDepositRefunded.is(event))
  expect(submissionRefunds.map((event) => (event.data as any).who.toHex())).toEqual([u8aToHex(submitter.publicKey)])
  const reservedAfter = (await client.api.query.system.account(payer.address)).data.reserved.toBigInt()
  expect(reservedBefore - reservedAfter).toBe(deposit)
}

/// ---------
/// Lifecycle
/// ---------

/**
 * Open a referendum on `track` that is deciding, and return its index.
 *
 * The prepare period is skipped by moving `submitted` back by it; the deposit is then real, and
 * starts the decision in the same extrinsic. Setup for the tests that follow a decision.
 */
async function openDecidingReferendum(
  client: Client<any, any>,
  cfg: RankedReferendaTestConfig,
  submitter: KeyringPair,
  payer: KeyringPair,
  track: RankedReferendaTrack,
  text: string,
): Promise<number> {
  const referenda = instance(client, cfg)
  const index = await submitReferendum(client, cfg, submitter, track, text)
  const head = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await setTimeAnchors(client, cfg, index, {
    submitted: head - trackInfo(client, cfg, track.id).preparePeriod.toNumber(),
  })
  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()
  assert((await ongoingStatus(client, cfg, index)).deciding.isSome, `setup referendum ${index} should be deciding`)
  return index
}

/** Inject a `Root` `nudgeReferendum` for `index` into the next block, build it, and check it dispatched. */
async function nudgeAsRoot(client: Client<any, any>, cfg: RankedReferendaTestConfig, index: number): Promise<void> {
  await scheduleInlineCallWithOrigin(
    client,
    instance(client, cfg).tx.nudgeReferendum(index).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  expect(
    (await dispatchedResults(client)).map((result) => result.isOk),
    'the Root nudge should dispatch',
  ).toEqual([true])
}

/**
 * The events of `method` from the instance in the head block that belong to referendum `index`.
 */
async function referendumEvents(
  client: Client<any, any>,
  cfg: RankedReferendaTestConfig,
  method: string,
  index: number,
) {
  const { events } = instance(client, cfg)
  return (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => events[method].is(event) && (event.data as any).index.toNumber() === index)
    .map((event) => event.data as any)
}

/**
 * A referendum that gets no decision deposit before `UndecidingTimeout` times out. Its submission
 * deposit then cannot be refunded (`BadStatus`), and there is no decision deposit to refund
 * (`NoDeposit`).
 *
 * The timeout is reached by moving `submitted` back by `UndecidingTimeout`; a `Root` nudge then
 * services the referendum as its own alarm would.
 *
 * 1. Seed a submitter and submit a referendum without a decision deposit
 * 2. Move `submitted` back so the timeout has passed by the next block, and nudge with `Root`
 * 3. Check `TimedOut` for the referendum with its empty tally
 * 4. Check it is stored as timed out in this block, holding the submission deposit and no decision
 *    deposit
 * 5. Check the submission deposit refund fails with `BadStatus` and the decision deposit refund with
 *    `NoDeposit`
 */
export async function timeOutWithoutDeposit(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_timeout_submitter`)

  // 1. A referendum without a decision deposit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} timeout`)

  // 2. Move past the timeout and nudge

  const head = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await setTimeAnchors(client, cfg, index, { submitted: head + 1 - referenda.consts.undecidingTimeout.toNumber() })
  await nudgeAsRoot(client, cfg, index)
  const timedOutAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 3. `TimedOut`

  await checkSystemEvents(client, { section: cfg.referenda, method: 'TimedOut' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('timeout without deposit: TimedOut')
  const timedOut = await referendumEvents(client, cfg, 'TimedOut', index)
  expect(timedOut).toHaveLength(1)
  expect(timedOut[0].tally.toJSON()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })

  // 4. Stored as timed out

  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isTimedOut, `referendum ${index} should be timed out`)
  const [moment, submission, decision] = info.unwrap().asTimedOut
  expect(moment.toNumber()).toBe(timedOutAt)
  expect(submission.unwrap().who.toHex()).toBe(u8aToHex(submitter.publicKey))
  expect(decision.isNone).toBe(true)

  // 5. Neither deposit can be refunded

  await sendTransaction(referenda.tx.refundSubmissionDeposit(index).signAsync(submitter))
  await client.dev.newBlock()
  await expectExtrinsicError(client, referenda.errors, 'BadStatus')
  await sendTransaction(referenda.tx.refundDecisionDeposit(index).signAsync(submitter))
  await client.dev.newBlock()
  await expectExtrinsicError(client, referenda.errors, 'NoDeposit')
}

/**
 * Move a deciding referendum's decision start back to 20 blocks before the end of its decision
 * period, then have every one of `voters` vote aye, and build the block holding those votes.
 * Near the end of the decision period both curves are close to their floors, so a few ayes pass,
 * and the votes' own alarm services the referendum in the next block. Returns the vote block.
 *
 * Setup shared by the confirmation tests; the votes and the tally are real.
 */
async function voteIntoConfirmation(
  client: Client<any, any>,
  cfg: RankedReferendaTestConfig,
  trackId: number,
  index: number,
  voters: KeyringPair[],
): Promise<number> {
  const referenda = instance(client, cfg)
  const head = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const decisionPeriod = trackInfo(client, cfg, trackId).decisionPeriod.toNumber()
  await setTimeAnchors(client, cfg, index, { deciding: { since: head - decisionPeriod + 20, confirming: null } })
  for (const voter of voters) {
    await sendTransaction(referenda.collectiveTx.vote(index, true).signAsync(voter))
  }
  await client.dev.newBlock()
  return (await client.api.rpc.chain.getHeader()).number.toNumber()
}

/**
 * A deciding referendum whose real tally passes both curves starts confirming. The pallet notices on
 * the alarm that the vote sets for the next block, with no outside nudge.
 *
 * The decision start is moved back to 20 blocks before the end of the decision period, where both
 * curves are near their floors, so one aye at the track's minimum rank passes.
 *
 * 1. Seed a member at the track's minimum rank, fund a payer, and open a deciding referendum
 * 2. Move the decision start back, and the member votes aye
 * 3. Check `Voted`, the referendum's tally, and that its alarm is due in the next block
 * 4. Build the next block, and check `ConfirmStarted` for the referendum
 * 5. Check the referendum is confirming until the end of the confirm period
 */
export async function confirmStartsOnPassingTally(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const member = keyring.addFromUri(`//${cfg.referenda}_confirm_member`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_confirm_payer`)
  const confirmPeriod = trackInfo(client, cfg, cfg.track.id).confirmPeriod.toNumber()

  // 1. A deciding referendum

  await seedRankedMembers(client, cfg, [{ pair: member, rank: cfg.trackMinRank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const index = await openDecidingReferendum(client, cfg, member, payer, cfg.track, `${cfg.referenda} confirm`)

  // 2. Move the decision start back, and vote aye

  const voteBlock = await voteIntoConfirmation(client, cfg, cfg.track.id, index, [member])

  // 3. `Voted`, the tally, and the alarm

  await checkSystemEvents(client, { section: cfg.collective, method: 'Voted' })
    .redact({ redactKeys: /^poll$/ })
    .toMatchSnapshot('confirm on passing tally: Voted')
  const ongoing = await ongoingStatus(client, cfg, index)
  // One vote at the minimum rank weighs 1 under both vote weight schemes in use.
  expect(ongoing.tally.toJSON()).toEqual({ bareAyes: 1, ayes: 1, nays: 0 })
  expect(ongoing.alarm.unwrap()[0].toNumber()).toBe(voteBlock + 1)

  // 4. `ConfirmStarted` in the next block

  await client.dev.newBlock()
  await checkSystemEvents(client, { section: cfg.referenda, method: 'ConfirmStarted' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('confirm on passing tally: ConfirmStarted')
  expect(await referendumEvents(client, cfg, 'ConfirmStarted', index)).toHaveLength(1)

  // 5. Confirming until the end of the confirm period

  const deciding = (await ongoingStatus(client, cfg, index)).deciding.unwrap()
  expect(deciding.confirming.unwrap().toNumber()).toBe(voteBlock + 1 + confirmPeriod)
}

/**
 * A confirming referendum whose tally stops passing stops confirming, but keeps deciding.
 *
 * On the Collectives Fellowship, a rank-5 nay on the Fellows track weighs 6 against a rank-3 aye
 * weighing 1, so approval falls to 1/7, below the approval curve.
 *
 * 1. Seed a rank-3 and a rank-5 member, fund a payer, and open a deciding referendum
 * 2. Bring it into confirmation with the rank-3 member's aye, and check `ConfirmStarted`
 * 3. The rank-5 member votes nay
 * 4. Build the next block, and check `ConfirmAborted` for the referendum
 * 5. Check the referendum is still deciding, no longer confirming, with both votes in its tally
 */
export async function confirmAbortsWhenTallyFails(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const aye = keyring.addFromUri(`//${cfg.referenda}_abort_aye`)
  const nay = keyring.addFromUri(`//${cfg.referenda}_abort_nay`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_abort_payer`)

  // 1. A deciding referendum

  await seedRankedMembers(
    client,
    cfg,
    [
      { pair: aye, rank: 3 },
      { pair: nay, rank: 5 },
    ],
    endowment(client, cfg),
  )
  await fundAccounts(client, [payer], endowment(client, cfg))
  const index = await openDecidingReferendum(client, cfg, aye, payer, cfg.track, `${cfg.referenda} abort`)

  // 2. Into confirmation

  await voteIntoConfirmation(client, cfg, cfg.track.id, index, [aye])
  await client.dev.newBlock()
  expect(await referendumEvents(client, cfg, 'ConfirmStarted', index)).toHaveLength(1)

  // 3. The rank-5 nay

  await sendTransaction(referenda.collectiveTx.vote(index, false).signAsync(nay))
  await client.dev.newBlock()

  // 4. `ConfirmAborted` in the next block

  await client.dev.newBlock()
  await checkSystemEvents(client, { section: cfg.referenda, method: 'ConfirmAborted' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('confirm aborts: ConfirmAborted')
  expect(await referendumEvents(client, cfg, 'ConfirmAborted', index)).toHaveLength(1)

  // 5. Still deciding, not confirming

  const ongoing = await ongoingStatus(client, cfg, index)
  expect(ongoing.deciding.isSome).toBe(true)
  expect(ongoing.deciding.unwrap().confirming.isNone).toBe(true)
  expect(ongoing.tally.toJSON()).toEqual({ bareAyes: 1, ayes: 1, nays: 6 })
}

/**
 * A referendum that stays passing to the end of its confirm period is confirmed. The pallet stores
 * it as approved, schedules its proposal under a named enactment task with the track's origin, and
 * frees its deciding slot one block later. Both deposits can then be refunded.
 *
 * The end of the confirm period is reached by moving `confirming` to the next block; a `Root` nudge
 * then services the referendum as its own alarm would.
 *
 * 1. Seed a member at the track's minimum rank, fund a payer, and open a deciding referendum
 * 2. Bring it into confirmation with the member's aye, and check `ConfirmStarted`
 * 3. Move the end of the confirm period to the next block, and nudge with `Root`
 * 4. Check `Confirmed` with the real tally, and the referendum is stored as approved with both
 *    deposits
 * 5. Check the enactment task: named for the referendum, due after `minEnactmentPeriod` (at least
 *    one block), carrying the proposal and the track's origin
 * 6. Build the next block, and check the track's deciding count is back where it started
 * 7. The payer refunds both deposits
 * 8. Check each refund event names its depositor and amount, the payer's deposit moved from
 *    reserved back to free (less the fee), and the approved referendum holds neither deposit
 */
export async function confirmedAndEnactmentScheduled(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const member = keyring.addFromUri(`//${cfg.referenda}_confirmed_member`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_confirmed_payer`)
  const track = trackInfo(client, cfg, cfg.track.id)

  // 1. A deciding referendum

  await seedRankedMembers(client, cfg, [{ pair: member, rank: cfg.trackMinRank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const decidingCountBefore = (await referenda.query.decidingCount(cfg.track.id)).toNumber()
  const index = await openDecidingReferendum(client, cfg, member, payer, cfg.track, `${cfg.referenda} confirmed`)
  const { origin, proposal } = await ongoingStatus(client, cfg, index)

  // 2. Into confirmation

  await voteIntoConfirmation(client, cfg, cfg.track.id, index, [member])
  await client.dev.newBlock()
  expect(await referendumEvents(client, cfg, 'ConfirmStarted', index)).toHaveLength(1)

  // 3. End the confirm period at the next block, and nudge

  const head = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const { since } = (await ongoingStatus(client, cfg, index)).deciding.unwrap()
  await setTimeAnchors(client, cfg, index, { deciding: { since: since.toNumber(), confirming: head + 1 } })
  await nudgeAsRoot(client, cfg, index)
  const confirmedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 4. `Confirmed`, and stored as approved

  await checkSystemEvents(client, { section: cfg.referenda, method: 'Confirmed' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('confirmed: Confirmed')
  const confirmed = await referendumEvents(client, cfg, 'Confirmed', index)
  expect(confirmed).toHaveLength(1)
  expect(confirmed[0].tally.toJSON()).toEqual({ bareAyes: 1, ayes: 1, nays: 0 })
  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isApproved, `referendum ${index} should be approved`)
  const [moment, submission, decision] = info.unwrap().asApproved
  expect(moment.toNumber()).toBe(confirmedAt)
  expect(submission.unwrap().who.toHex()).toBe(u8aToHex(member.publicKey))
  expect(decision.unwrap().who.toHex()).toBe(u8aToHex(payer.publicKey))

  // 5. The named enactment task

  const name = enactmentTaskName(client, index)
  const lookup = await client.api.query.scheduler.lookup(name)
  assert(lookup.isSome, 'the enactment task should be scheduled under its name')
  const [enactAt, slot] = lookup.unwrap()
  expect(enactAt.toNumber()).toBe(confirmedAt + Math.max(track.minEnactmentPeriod.toNumber(), 1))
  const task = [...(await client.api.query.scheduler.agenda(enactAt.toNumber()))][slot.toNumber()]
  assert(task?.isSome, 'the enactment task should be in the agenda')
  expect(task.unwrap().maybeId.unwrap().toHex()).toBe(name)
  expect(task.unwrap().call.toHex()).toBe(proposal.toHex())
  expect(task.unwrap().origin.toHex()).toBe(origin.toHex())

  // 6. The deciding slot is freed one block later

  await client.dev.newBlock()
  expect((await referenda.query.decidingCount(cfg.track.id)).toNumber()).toBe(decidingCountBefore)

  // 7. The payer refunds both deposits

  const payerBefore = (await client.api.query.system.account(payer.address)).data
  await sendTransaction(
    client.api.tx.utility
      .batchAll([referenda.tx.refundDecisionDeposit(index), referenda.tx.refundSubmissionDeposit(index)])
      .signAsync(payer),
  )
  await client.dev.newBlock()

  // 8. Refund events, balances, and the approved record

  await checkSystemEvents(
    client,
    { section: cfg.referenda, method: 'DecisionDepositRefunded' },
    { section: cfg.referenda, method: 'SubmissionDepositRefunded' },
  )
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('confirmed: both deposits refunded after approval')
  const deposit = track.decisionDeposit.toBigInt()
  const decisionRefunds = await referendumEvents(client, cfg, 'DecisionDepositRefunded', index)
  expect(decisionRefunds.map((data) => [data.who.toHex(), data.amount.toBigInt()])).toEqual([
    [u8aToHex(payer.publicKey), deposit],
  ])
  const submissionRefunds = await referendumEvents(client, cfg, 'SubmissionDepositRefunded', index)
  expect(submissionRefunds.map((data) => [data.who.toHex(), data.amount.toBigInt()])).toEqual([
    [u8aToHex(member.publicKey), referenda.consts.submissionDeposit.toBigInt()],
  ])
  const fee = await feePaidBy(client, payer)
  const payerAfter = (await client.api.query.system.account(payer.address)).data
  expect(payerBefore.reserved.toBigInt() - payerAfter.reserved.toBigInt()).toBe(deposit)
  expect(payerAfter.free.toBigInt() - payerBefore.free.toBigInt()).toBe(deposit - fee)
  const refunded = await referenda.query.referendumInfoFor(index)
  assert(refunded.isSome && refunded.unwrap().isApproved, `referendum ${index} should still be approved`)
  const [refundedMoment, submissionLeft, decisionLeft] = refunded.unwrap().asApproved
  expect(refundedMoment.toNumber()).toBe(confirmedAt)
  expect(submissionLeft.isNone).toBe(true)
  expect(decisionLeft.isNone).toBe(true)
}

/**
 * A deciding referendum that has not passed by the end of its decision period is rejected. Its
 * deciding slot is freed one block later; the decision deposit can be refunded, but the submission
 * deposit cannot (`BadStatus`).
 *
 * The tally is the real empty tally, which fails the approval curve. The end of the decision period
 * is reached by moving the decision start back by the decision period; a `Root` nudge then services
 * the referendum.
 *
 * 1. Seed a submitter, fund a payer, and open a deciding referendum
 * 2. Move the decision start back by the decision period, and nudge with `Root`
 * 3. Check `Rejected` with the empty tally, and the referendum is stored as rejected with both
 *    deposits
 * 4. Build the next block, and check the track's deciding count is back where it started
 * 5. Check the decision deposit is refunded, and the submission deposit refund fails with
 *    `BadStatus`
 */
export async function rejectedAtDecisionEnd(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_rejected_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_rejected_payer`)

  // 1. A deciding referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  const decidingCountBefore = (await referenda.query.decidingCount(cfg.track.id)).toNumber()
  const index = await openDecidingReferendum(client, cfg, submitter, payer, cfg.track, `${cfg.referenda} rejected`)

  // 2. End the decision period, and nudge

  const head = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const decisionPeriod = trackInfo(client, cfg, cfg.track.id).decisionPeriod.toNumber()
  await setTimeAnchors(client, cfg, index, { deciding: { since: head + 1 - decisionPeriod, confirming: null } })
  await nudgeAsRoot(client, cfg, index)
  const rejectedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 3. `Rejected`, and stored as rejected

  await checkSystemEvents(client, { section: cfg.referenda, method: 'Rejected' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('rejected at decision end: Rejected')
  const rejected = await referendumEvents(client, cfg, 'Rejected', index)
  expect(rejected).toHaveLength(1)
  expect(rejected[0].tally.toJSON()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })
  const info = await referenda.query.referendumInfoFor(index)
  assert(info.isSome && info.unwrap().isRejected, `referendum ${index} should be rejected`)
  const [moment, submission, decision] = info.unwrap().asRejected
  expect(moment.toNumber()).toBe(rejectedAt)
  expect(submission.isSome && decision.isSome).toBe(true)

  // 4. The deciding slot is freed one block later

  await client.dev.newBlock()
  expect((await referenda.query.decidingCount(cfg.track.id)).toNumber()).toBe(decidingCountBefore)

  // 5. Decision deposit refunded; submission deposit not

  await sendTransaction(referenda.tx.refundDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()
  expect(await referendumEvents(client, cfg, 'DecisionDepositRefunded', index)).toHaveLength(1)
  await sendTransaction(referenda.tx.refundSubmissionDeposit(index).signAsync(submitter))
  await client.dev.newBlock()
  await expectExtrinsicError(client, referenda.errors, 'BadStatus')
}

/// ---------------
/// Root-only calls
/// ---------------

/**
 * The pallet's internal calls, `nudgeReferendum` and `oneFewerDeciding`, accept only `Root`, and its
 * user calls accept only a signed origin. So a member's signed `nudgeReferendum` and
 * `oneFewerDeciding` fail with `BadOrigin`, and so do `placeDecisionDeposit` and `setMetadata`
 * dispatched as `Root`.
 *
 * 1. Seed a submitter and submit a referendum
 * 2. The submitter signs `nudgeReferendum`, and check it fails with `BadOrigin`
 * 3. The submitter signs `oneFewerDeciding` for the referendum's track, and check it fails with
 *    `BadOrigin`
 * 4. Inject `placeDecisionDeposit` and a clearing `setMetadata` with `Root` into one block
 * 5. Check both dispatched with `BadOrigin`, and the referendum and the track's deciding count are
 *    unchanged
 */
export async function wrongOriginForInternalAndSignedCalls(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_wrong_origin_submitter`)

  // 1. Submit a referendum

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} wrong origin`)
  const statusBefore = (await ongoingStatus(client, cfg, index)).toHex()
  const decidingCountBefore = (await referenda.query.decidingCount(cfg.track.id)).toNumber()

  // 2. A signed `nudgeReferendum`

  await sendTransaction(referenda.tx.nudgeReferendum(index).signAsync(submitter))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed nudgeReferendum: ExtrinsicFailed',
  )
  await expectExtrinsicBadOrigin(client)

  // 3. A signed `oneFewerDeciding`

  await sendTransaction(referenda.tx.oneFewerDeciding(cfg.track.id).signAsync(submitter))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed oneFewerDeciding: ExtrinsicFailed',
  )
  await expectExtrinsicBadOrigin(client)

  // 4. `placeDecisionDeposit` and `setMetadata` as `Root`

  await scheduleCallListWithOrigin(
    client,
    [referenda.tx.placeDecisionDeposit(index), referenda.tx.setMetadata(index, null)].map((call) => ({
      call: { Inline: call.method.toHex() },
      origin: { system: 'Root' },
    })),
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 5. Both `BadOrigin`, and nothing changed

  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('Root placeDecisionDeposit and setMetadata: Dispatched')
  const results = await dispatchedResults(client)
  expect(results.map((result) => result.isErr && result.asErr.isBadOrigin)).toEqual([true, true])
  expect((await ongoingStatus(client, cfg, index)).toHex()).toBe(statusBefore)
  expect((await referenda.query.decidingCount(cfg.track.id)).toNumber()).toBe(decidingCountBefore)
}

/**
 * `nudgeReferendum` services only an ongoing referendum: on a cancelled one it fails with
 * `NotOngoing`, and the stored outcome is unchanged.
 *
 * 1. Seed a submitter, submit a referendum, and cancel it
 * 2. Inject `nudgeReferendum` for it with `Root`
 * 3. Check it dispatched with `NotOngoing`, and the referendum is still stored as cancelled
 */
export async function nudgeFinishedReferendum(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_nudge_finished`)

  // 1. Submit and cancel

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} nudge finished`)
  await dispatchSetupCalls(client, [{ call: referenda.tx.cancel(index), origin: cfg.cancelOrigins.accepted[0] }])
  const infoBefore = (await referenda.query.referendumInfoFor(index)).toHex()

  // 2. Nudge it as `Root`

  await scheduleInlineCallWithOrigin(
    client,
    referenda.tx.nudgeReferendum(index).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `NotOngoing`, and the outcome is unchanged

  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('nudge a cancelled referendum: Dispatched')
  const results = await dispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(referenda.errors.NotOngoing.is(results[0].asErr.asModule)).toBe(true)
  expect((await referenda.query.referendumInfoFor(index)).toHex()).toBe(infoBefore)
}

/**
 * `oneFewerDeciding` rejects a track the instance does not define, with `BadTrack`.
 *
 * 1. Check track 10 is not in the instance's `tracks` constant
 * 2. Inject `oneFewerDeciding(10)` with `Root`
 * 3. Check it dispatched with `BadTrack`, and no deciding count exists for track 10
 */
export async function oneFewerDecidingUnknownTrack(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const unknownTrack = 10

  // 1. Track 10 does not exist

  const trackIds = (referenda.consts.tracks as any[]).map(([id]) => id.toNumber())
  expect(trackIds).not.toContain(unknownTrack)

  // 2. `oneFewerDeciding(10)` as `Root`

  await scheduleInlineCallWithOrigin(
    client,
    referenda.tx.oneFewerDeciding(unknownTrack).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadTrack`

  await checkSystemEvents(client, { section: 'scheduler', method: 'Dispatched' })
    .redact({ redactKeys: /^task$/ })
    .toMatchSnapshot('oneFewerDeciding on an unknown track: Dispatched')
  const results = await dispatchedResults(client)
  expect(results).toHaveLength(1)
  assert(results[0].isErr && results[0].asErr.isModule, `expected a module error, got ${results[0].toString()}`)
  expect(referenda.errors.BadTrack.is(results[0].asErr.asModule)).toBe(true)
  expect((await referenda.query.decidingCount(unknownTrack)).toNumber()).toBe(0)
}

/**
 * When a track is full, a referendum that is ready to decide waits in the track's queue. A
 * `oneFewerDeciding` for the track then moves it into deciding, and the deciding count stays at
 * the limit.
 *
 * Track 21 (`PromoteTo1Dan`) has no prepare period. Filling it for real takes `maxDeciding`
 * deciding referenda, so its deciding count is written at the limit instead, and its queue is
 * emptied of any live entries. Both writes are read back.
 *
 * 1. Seed a submitter and a payer; set track 21's deciding count to `maxDeciding` and empty its
 *    queue
 * 2. Submit on track 21 and place the decision deposit
 * 3. Check the deposit is placed but the decision does not start: the referendum is queued
 * 4. Inject `oneFewerDeciding(21)` with `Root`
 * 5. Check `DecisionStarted` for the queued referendum, the queue is empty, and the deciding count is
 *    still `maxDeciding`
 */
export async function oneFewerDecidingStartsQueued(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_queued_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_queued_payer`)
  const track: RankedReferendaTrack = { id: 21, origin: { FellowshipOrigins: 'PromoteTo1Dan' } }
  const info = trackInfo(client, cfg, track.id)
  const maxDeciding = info.maxDeciding.toNumber()
  expect(info.preparePeriod.toNumber()).toBe(0)

  // 1. Seed, fund, and fill track 21 to its limit

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  await client.api.rpc('dev_setStorage', [
    // `toU8a` is the SCALE encoding; a `u32`'s `toHex` is its big-endian number, not its encoding.
    [referenda.query.decidingCount.key(track.id), u8aToHex(client.api.createType('u32', maxDeciding).toU8a())],
    [referenda.query.trackQueue.key(track.id), null],
  ])
  expect((await referenda.query.decidingCount(track.id)).toNumber()).toBe(maxDeciding)
  expect((await referenda.query.trackQueue(track.id)).length).toBe(0)

  // 2. Submit and place the deposit

  const index = await submitReferendum(client, cfg, submitter, track, `${cfg.referenda} queued`)
  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()

  // 3. Deposit placed, decision not started: queued

  expect(await referendumEvents(client, cfg, 'DecisionDepositPlaced', index)).toHaveLength(1)
  expect(await referendumEvents(client, cfg, 'DecisionStarted', index)).toHaveLength(0)
  const queued = await ongoingStatus(client, cfg, index)
  expect(queued.inQueue.isTrue).toBe(true)
  expect(queued.deciding.isNone).toBe(true)
  expect((await referenda.query.trackQueue(track.id)).toJSON()).toEqual([[index, 0]])

  // 4. `oneFewerDeciding(21)` as `Root`

  await scheduleInlineCallWithOrigin(
    client,
    referenda.tx.oneFewerDeciding(track.id).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  const startedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 5. The queued referendum starts deciding; the count stays at the limit

  await checkSystemEvents(
    client,
    { section: 'scheduler', method: 'Dispatched' },
    { section: cfg.referenda, method: 'DecisionStarted' },
  )
    .redact({ hash: false, redactKeys: /^(index|task)$/ })
    .toMatchSnapshot('oneFewerDeciding with a queue: Dispatched and DecisionStarted')
  expect((await dispatchedResults(client)).map((result) => result.isOk)).toEqual([true])
  expect(await referendumEvents(client, cfg, 'DecisionStarted', index)).toHaveLength(1)
  const deciding = await ongoingStatus(client, cfg, index)
  expect(deciding.inQueue.isTrue).toBe(false)
  expect(deciding.deciding.unwrap().since.toNumber()).toBe(startedAt)
  expect((await referenda.query.trackQueue(track.id)).length).toBe(0)
  expect((await referenda.query.decidingCount(track.id)).toNumber()).toBe(maxDeciding)
}

/**
 * With an empty queue, `oneFewerDeciding` only lowers the track's deciding count by one.
 *
 * Track 21 (`PromoteTo1Dan`) has no prepare period, so a decision deposit starts the decision
 * straight away.
 *
 * 1. Seed a submitter and a payer, and check track 21's queue is empty
 * 2. Open a deciding referendum on track 21, and check the deciding count rose by one
 * 3. Inject `oneFewerDeciding(21)` with `Root`
 * 4. Check it dispatched, no decision started, and the deciding count fell by one
 */
export async function oneFewerDecidingEmptyQueue(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_empty_queue_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_empty_queue_payer`)
  const track: RankedReferendaTrack = { id: 21, origin: { FellowshipOrigins: 'PromoteTo1Dan' } }
  expect(trackInfo(client, cfg, track.id).preparePeriod.toNumber()).toBe(0)

  // 1. Seed, fund, and check the queue is empty

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [payer], endowment(client, cfg))
  expect((await referenda.query.trackQueue(track.id)).length).toBe(0)
  const decidingCountBefore = (await referenda.query.decidingCount(track.id)).toNumber()

  // 2. One deciding referendum

  const index = await submitReferendum(client, cfg, submitter, track, `${cfg.referenda} empty queue`)
  await sendTransaction(referenda.tx.placeDecisionDeposit(index).signAsync(payer))
  await client.dev.newBlock()
  expect((await ongoingStatus(client, cfg, index)).deciding.isSome).toBe(true)
  expect((await referenda.query.decidingCount(track.id)).toNumber()).toBe(decidingCountBefore + 1)

  // 3. `oneFewerDeciding(21)` as `Root`

  await scheduleInlineCallWithOrigin(
    client,
    referenda.tx.oneFewerDeciding(track.id).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. Dispatched, nothing started, and one fewer deciding

  expect((await dispatchedResults(client)).map((result) => result.isOk)).toEqual([true])
  const started = (await client.api.query.system.events()).filter(({ event }) =>
    referenda.events.DecisionStarted.is(event),
  )
  expect(started).toHaveLength(0)
  expect((await referenda.query.decidingCount(track.id)).toNumber()).toBe(decidingCountBefore)
}

/// --------
/// Metadata
/// --------

/**
 * The `[index, hash]` pairs of the instance's `event` (`MetadataSet` or `MetadataCleared`) in the
 * head block. PJS exposes the events' `hash` field as `hash_`, because `hash` is every codec's own
 * hash getter.
 */
async function metadataEvents(client: Client<any, any>, cfg: RankedReferendaTestConfig, event: string) {
  const { events } = instance(client, cfg)
  return (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((record) => events[event].is(record))
    .map((record) => [(record.data as any).index.toNumber(), (record.data as any).hash_.toHex()])
}

/**
 * The submitter of an ongoing referendum may attach metadata, the hash of a noted preimage, and
 * clear it again.
 *
 * 1. Seed a submitter, submit a referendum, and note a metadata preimage
 * 2. The submitter sets the metadata
 * 3. Check `MetadataSet` carries the referendum and the hash, and `MetadataOf` stores the hash
 * 4. The submitter clears the metadata
 * 5. Check `MetadataCleared` carries the same hash, and `MetadataOf` is empty
 */
export async function setAndClearMetadata(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_metadata_submitter`)
  const metadata = stringToHex(`${cfg.referenda} metadata set and clear`)
  const hash = blake2AsHex(metadata)

  // 1. Submit, and note the metadata preimage

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} metadata`)
  await sendTransaction(client.api.tx.preimage.notePreimage(metadata).signAsync(submitter))
  await client.dev.newBlock()
  expect((await client.api.query.preimage.requestStatusFor(hash)).isSome, 'the preimage should be noted').toBe(true)

  // 2. Set the metadata

  await sendTransaction(referenda.tx.setMetadata(index, hash).signAsync(submitter))
  await client.dev.newBlock()

  // 3. `MetadataSet`, and the stored hash

  await checkSystemEvents(client, { section: cfg.referenda, method: 'MetadataSet' })
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('metadata: MetadataSet')
  expect(await metadataEvents(client, cfg, 'MetadataSet')).toEqual([[index, hash]])
  expect((await referenda.query.metadataOf(index)).unwrap().toHex()).toBe(hash)

  // 4. Clear the metadata

  await sendTransaction(referenda.tx.setMetadata(index, null).signAsync(submitter))
  await client.dev.newBlock()

  // 5. `MetadataCleared`, and nothing stored

  await checkSystemEvents(client, { section: cfg.referenda, method: 'MetadataCleared' })
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('metadata: MetadataCleared')
  expect(await metadataEvents(client, cfg, 'MetadataCleared')).toEqual([[index, hash]])
  expect((await referenda.query.metadataOf(index)).isNone).toBe(true)
}

/**
 * Only the submitter may set or clear an ongoing referendum's metadata: another member gets
 * `NoPermission` for both, and the metadata stays.
 *
 * 1. Seed a submitter and another member; submit, note a preimage, and set the metadata as the
 *    submitter
 * 2. The other member sets metadata to the same hash, and check it fails with `NoPermission`
 * 3. The other member clears the metadata, and check it fails with `NoPermission`
 * 4. Check `MetadataOf` still holds the submitter's hash
 */
export async function metadataByNonSubmitter(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_permission_submitter`)
  const other = keyring.addFromUri(`//${cfg.referenda}_permission_other`)
  const metadata = stringToHex(`${cfg.referenda} metadata permission`)
  const hash = blake2AsHex(metadata)

  // 1. Submit, and set the metadata as the submitter

  await seedRankedMembers(
    client,
    cfg,
    [
      { pair: submitter, rank: cfg.submitAnyTrack.rank },
      { pair: other, rank: cfg.submitAnyTrack.rank },
    ],
    endowment(client, cfg),
  )
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} permission`)
  await sendTransaction(
    client.api.tx.utility
      .batchAll([client.api.tx.preimage.notePreimage(metadata), referenda.tx.setMetadata(index, hash)])
      .signAsync(submitter),
  )
  await client.dev.newBlock()
  expect((await referenda.query.metadataOf(index)).unwrap().toHex(), 'setup metadata should be set').toBe(hash)

  // 2. Another member sets metadata

  await sendTransaction(referenda.tx.setMetadata(index, hash).signAsync(other))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'metadata set by another member: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NoPermission')

  // 3. Another member clears metadata

  await sendTransaction(referenda.tx.setMetadata(index, null).signAsync(other))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'metadata cleared by another member: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NoPermission')

  // 4. The submitter's metadata stays

  expect((await referenda.query.metadataOf(index)).unwrap().toHex()).toBe(hash)
}

/**
 * Metadata must be the hash of a noted preimage: a hash with no preimage fails with
 * `PreimageNotExist`.
 *
 * 1. Seed a submitter and submit a referendum; pick a hash that has no preimage
 * 2. The submitter sets that hash as metadata
 * 3. Check it fails with `PreimageNotExist`, and `MetadataOf` is empty
 */
export async function metadataWithoutPreimage(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_no_preimage_submitter`)
  const hash = blake2AsHex(stringToHex(`${cfg.referenda} metadata never noted`))

  // 1. Submit, and pick a hash with no preimage

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} no preimage`)
  expect((await client.api.query.preimage.requestStatusFor(hash)).isNone).toBe(true)

  // 2. Set that hash

  await sendTransaction(referenda.tx.setMetadata(index, hash).signAsync(submitter))
  await client.dev.newBlock()

  // 3. `PreimageNotExist`, and nothing stored

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'metadata without a preimage: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'PreimageNotExist')
  expect((await referenda.query.metadataOf(index)).isNone).toBe(true)
}

/**
 * Once a referendum has ended, its metadata cannot be set (`NotOngoing`), but anyone may clear it.
 *
 * 1. Seed a submitter and fund a non-member; submit, note a preimage, set the metadata, and cancel
 *    the referendum
 * 2. The submitter sets metadata again, and check it fails with `NotOngoing`
 * 3. The non-member clears the metadata
 * 4. Check `MetadataCleared` carries the hash, and `MetadataOf` is empty
 */
export async function metadataAfterReferendumEnds(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_ended_metadata_submitter`)
  const stranger = keyring.addFromUri(`//${cfg.referenda}_ended_metadata_stranger`)
  const metadata = stringToHex(`${cfg.referenda} metadata after end`)
  const hash = blake2AsHex(metadata)

  // 1. Submit, set the metadata, and cancel

  await seedRankedMembers(client, cfg, [{ pair: submitter, rank: cfg.submitAnyTrack.rank }], endowment(client, cfg))
  await fundAccounts(client, [stranger], endowment(client, cfg))
  const index = await submitReferendum(client, cfg, submitter, cfg.track, `${cfg.referenda} ended metadata`)
  await sendTransaction(
    client.api.tx.utility
      .batchAll([client.api.tx.preimage.notePreimage(metadata), referenda.tx.setMetadata(index, hash)])
      .signAsync(submitter),
  )
  await client.dev.newBlock()
  expect((await referenda.query.metadataOf(index)).unwrap().toHex(), 'setup metadata should be set').toBe(hash)
  await dispatchSetupCalls(client, [{ call: referenda.tx.cancel(index), origin: cfg.cancelOrigins.accepted[0] }])

  // 2. Setting metadata on the ended referendum

  await sendTransaction(referenda.tx.setMetadata(index, hash).signAsync(submitter))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'metadata set after the referendum ended: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, referenda.errors, 'NotOngoing')

  // 3. A non-member clears it

  await sendTransaction(referenda.tx.setMetadata(index, null).signAsync(stranger))
  await client.dev.newBlock()

  // 4. `MetadataCleared`, and nothing stored

  await checkSystemEvents(client, { section: cfg.referenda, method: 'MetadataCleared' })
    .redact({ hash: false, redactKeys: /^index$/ })
    .toMatchSnapshot('metadata cleared by anyone after the referendum ended: MetadataCleared')
  expect(await metadataEvents(client, cfg, 'MetadataCleared')).toEqual([[index, hash]])
  expect((await referenda.query.metadataOf(index)).isNone).toBe(true)
}

/// ---------------
/// Voting behavior
/// ---------------

/**
 * A vote's weight depends on how far the voter's rank exceeds the track's minimum rank
 * (`MinRankOfClass`), through the runtime's `VoteWeight`. A member below the minimum cannot vote.
 * The track and expected weights come from `cfg.voteWeights`.
 *
 * 1. Seed a submitter, the configured voters, and a member below the track's minimum rank; submit
 *    on the track
 * 2. The member below the minimum votes aye; check it fails with `RankTooLow` and the tally is empty
 * 3. Every configured voter votes aye in one block
 * 4. Check one `Voted` per voter, carrying the configured weight
 * 5. Check the tally: the weights summed in `ayes`, one head per voter in `bareAyes`, no nays
 */
export async function voteWeightsByExcessRank(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  assert(cfg.voteWeights, `${cfg.testSuiteName} has no vote weight configuration`)
  const { track, belowRank, voters } = cfg.voteWeights
  const referenda = instance(client, cfg)
  const collectiveErrors = (client.api.errors as any)[cfg.collective]
  const submitter = keyring.addFromUri(`//${cfg.referenda}_weights_submitter`)
  const below = keyring.addFromUri(`//${cfg.referenda}_weights_below`)
  const pairs = voters.map(({ rank }) => keyring.addFromUri(`//${cfg.referenda}_weights_rank_${rank}`))

  // 1. Seed the members, and submit on the track

  await seedRankedMembers(
    client,
    cfg,
    [
      { pair: submitter, rank: cfg.submitAnyTrack.rank },
      { pair: below, rank: belowRank },
      ...voters.map(({ rank }, i) => ({ pair: pairs[i], rank })),
    ],
    endowment(client, cfg),
  )
  const index = await submitReferendum(client, cfg, submitter, track, `${cfg.referenda} vote weights`)

  // 2. A member below the minimum cannot vote

  await sendTransaction(referenda.collectiveTx.vote(index, true).signAsync(below))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    `vote below the minimum rank of track ${track.id}: ExtrinsicFailed`,
  )
  await expectExtrinsicError(client, collectiveErrors, 'RankTooLow')
  expect((await ongoingStatus(client, cfg, index)).tally.toJSON()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })

  // 3. Every voter votes aye

  for (const pair of pairs) {
    await sendTransaction(referenda.collectiveTx.vote(index, true).signAsync(pair))
  }
  await client.dev.newBlock()

  // 4. One `Voted` per voter, with its weight

  await checkSystemEvents(client, { section: cfg.collective, method: 'Voted' })
    .redact({ redactKeys: /^poll$/ })
    .toMatchSnapshot(`votes on track ${track.id}: Voted`)
  const voted = (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => (client.api.events as any)[cfg.collective].Voted.is(event))
    .map((event) => [(event.data as any).who.toHex(), (event.data as any).vote.toJSON()])
  expect(voted).toHaveLength(voters.length)
  for (const [i, { weight }] of voters.entries()) {
    expect(voted, `voter of rank ${voters[i].rank}`).toContainEqual([u8aToHex(pairs[i].publicKey), { aye: weight }])
  }

  // 5. The tally

  expect((await ongoingStatus(client, cfg, index)).tally.toJSON()).toEqual({
    bareAyes: voters.length,
    ayes: voters.reduce((sum, { weight }) => sum + weight, 0),
    nays: 0,
  })
}

/**
 * On the Collectives Fellowship a retention track's minimum voting rank is its track id minus 8, so
 * on track 13 (`RetainAt3Dan`) it is rank 5. A rank-4 member, who may vote on the rank-4 Architects
 * track, cannot vote here; a rank-5 member's aye weighs 1, as at the minimum of any track.
 *
 * 1. Seed a rank-3 submitter, a rank-4 and a rank-5 member; submit on track 13
 * 2. The rank-4 member votes aye; check it fails with `RankTooLow` and the tally is empty
 * 3. The rank-5 member votes aye
 * 4. Check `Voted` carries weight 1, and the tally holds that one aye
 */
export async function retentionTrackMinimumRank(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_retention_submitter`)
  const rank4 = keyring.addFromUri(`//${cfg.referenda}_retention_rank_4`)
  const rank5 = keyring.addFromUri(`//${cfg.referenda}_retention_rank_5`)
  const track: RankedReferendaTrack = { id: 13, origin: { FellowshipOrigins: 'RetainAt3Dan' } }

  // 1. Seed the members, and submit on track 13

  await seedRankedMembers(
    client,
    cfg,
    [
      { pair: submitter, rank: 3 },
      { pair: rank4, rank: 4 },
      { pair: rank5, rank: 5 },
    ],
    endowment(client, cfg),
  )
  const index = await submitReferendum(client, cfg, submitter, track, `${cfg.referenda} retention minimum`)

  // 2. Rank 4 is below the minimum

  await sendTransaction(referenda.collectiveTx.vote(index, true).signAsync(rank4))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'rank 4 on a retention track: ExtrinsicFailed',
  )
  await expectExtrinsicError(client, client.api.errors.fellowshipCollective, 'RankTooLow')
  expect((await ongoingStatus(client, cfg, index)).tally.toJSON()).toEqual({ bareAyes: 0, ayes: 0, nays: 0 })

  // 3. Rank 5 votes

  await sendTransaction(referenda.collectiveTx.vote(index, true).signAsync(rank5))
  await client.dev.newBlock()

  // 4. Weight 1

  await checkSystemEvents(client, { section: 'fellowshipCollective', method: 'Voted' })
    .redact({ redactKeys: /^poll$/ })
    .toMatchSnapshot('rank 5 on a retention track: Voted')
  const voted = (await client.api.query.system.events())
    .map(({ event }) => event)
    .filter((event) => client.api.events.fellowshipCollective.Voted.is(event))
    .map((event) => [(event.data as any).who.toHex(), (event.data as any).vote.toJSON()])
  expect(voted).toEqual([[u8aToHex(rank5.publicKey), { aye: 1 }]])
  expect((await ongoingStatus(client, cfg, index)).tally.toJSON()).toEqual({ bareAyes: 1, ayes: 1, nays: 0 })
}

/**
 * Support is the share of members at the track's minimum rank who voted aye, so on a retention
 * track it is counted against the rank-5 tier, not the whole Fellowship. Near the end of the
 * decision period track 13's support curve is at its floor. The test casts just enough rank-5 ayes
 * to clear that floor against the rank-5 tier, while the same ayes stay below it against the
 * rank-3 tier, so `ConfirmStarted` shows which tier the support was counted against.
 *
 * Both tiers are live, so the number of voters is worked out from the live member counts, and
 * rank-3 members who do not vote are added when the rank-3 tier is too small to keep the two
 * apart. The decision start is moved back to 20 blocks before the end of the decision period; the
 * votes and the member counts are real.
 *
 * 1. From the live member counts, work out how many rank-5 voters clear the support threshold, and
 *    how many extra rank-3 members keep the same ayes below it against the rank-3 tier
 * 2. Seed a rank-3 submitter, the rank-5 voters and the extra rank-3 members, fund a payer, and
 *    open a deciding referendum on track 13
 * 3. Check, from the member counts after seeding, that the ayes clear the threshold against the
 *    rank-5 tier but not against the rank-3 tier
 * 4. Move the decision start back, and every rank-5 voter votes aye
 * 5. Build the next block, and check `ConfirmStarted` for the referendum
 */
export async function retentionSupportCountsMinimumRank(client: Client<any, any>, cfg: RankedReferendaTestConfig) {
  const referenda = instance(client, cfg)
  const submitter = keyring.addFromUri(`//${cfg.referenda}_support_submitter`)
  const payer = keyring.addFromUri(`//${cfg.referenda}_support_payer`)
  const track: RankedReferendaTrack = { id: 13, origin: { FellowshipOrigins: 'RetainAt3Dan' } }
  const info = trackInfo(client, cfg, track.id)

  // 1. Size the voters and the extra rank-3 members from the live tiers

  // The votes land 19 blocks and are serviced 18 blocks before the end of the decision period, where
  // a linear decreasing curve has fallen to `floor + (ceil - floor) * 18 / decisionPeriod`.
  const curve = info.minSupport.asLinearDecreasing
  const floor = curve.floor.toNumber() / 1e9
  const ceil = curve.ceil.toNumber() / 1e9
  const threshold = floor + ((ceil - floor) * 18) / info.decisionPeriod.toNumber()
  expect(threshold, 'the support threshold must be reachable').toBeLessThan(1)
  const liveRank5 = (await referenda.collectiveQuery.memberCount(5)).toNumber()
  const liveRank3 = (await referenda.collectiveQuery.memberCount(3)).toNumber()
  // The fewest rank-5 voters whose ayes reach the threshold once they are counted in the rank-5 tier.
  let voterCount = 1
  while (voterCount / (liveRank5 + voterCount) < threshold) voterCount++
  // Extra rank-3 members until the same ayes fall below the threshold against the rank-3 tier,
  // which also counts the voters.
  let extraCount = 0
  while (voterCount / (liveRank3 + voterCount + extraCount) >= threshold) extraCount++
  const voters = Array.from({ length: voterCount }, (_, i) =>
    keyring.addFromUri(`//${cfg.referenda}_support_rank_5_${i}`),
  )
  const extras = Array.from({ length: extraCount }, (_, i) =>
    keyring.addFromUri(`//${cfg.referenda}_support_rank_3_${i}`),
  )

  // 2. Seed, and open a deciding referendum on track 13

  await seedRankedMembers(
    client,
    cfg,
    [
      { pair: submitter, rank: 3 },
      ...voters.map((pair) => ({ pair, rank: 5 })),
      ...extras.map((pair) => ({ pair, rank: 3 })),
    ],
    endowment(client, cfg),
  )
  await fundAccounts(client, [payer], endowment(client, cfg))
  const index = await openDecidingReferendum(client, cfg, submitter, payer, track, `${cfg.referenda} support`)

  // 3. The ayes clear the threshold against rank 5, not against rank 3

  const membersAtRank5 = (await referenda.collectiveQuery.memberCount(5)).toNumber()
  const membersAtRank3 = (await referenda.collectiveQuery.memberCount(3)).toNumber()
  expect(
    voterCount / membersAtRank5,
    'the ayes among rank-5 members should clear the threshold',
  ).toBeGreaterThanOrEqual(threshold)
  expect(voterCount / membersAtRank3, 'the same ayes among rank-3 members should not').toBeLessThan(threshold)

  // 4. Move the decision start back, and vote

  await voteIntoConfirmation(client, cfg, track.id, index, voters)

  // 5. `ConfirmStarted`

  await client.dev.newBlock()
  await checkSystemEvents(client, { section: cfg.referenda, method: 'ConfirmStarted' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('retention support: ConfirmStarted')
  expect(await referendumEvents(client, cfg, 'ConfirmStarted', index)).toHaveLength(1)
}

/// ----------
/// Test trees
/// ----------

/**
 * Submission tests that every ranked referenda instance runs. Their outcome depends only on the
 * instance's `SubmitOrigin` and tracks, which `cfg` describes.
 */
function submissionTests(getClient: () => Client<any, any>, cfg: RankedReferendaTestConfig): TestNode[] {
  return [
    {
      kind: 'test',
      label: 'submit - member at the minimum rank on the top track, Submitted',
      testFn: () => submitAtMinimumRank(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'submit - below the minimum rank or not a member - BadOrigin',
      testFn: () => submitRejectedOrigins(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'submit - proposal origin with no track - NoTrack',
      testFn: () => submitWithoutTrack(getClient(), cfg),
    },
  ]
}

/**
 * Decision deposit tests that every ranked referenda instance runs. Their outcome depends on the
 * instance's track deposits, prepare periods and deciding slots.
 */
function decisionDepositTests(getClient: () => Client<any, any>, cfg: RankedReferendaTestConfig): TestNode[] {
  return [
    {
      kind: 'test',
      label: 'placeDecisionDeposit - paid by a non-member, deposit reserved and preparing',
      testFn: () => placeDepositInPreparePeriod(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'placeDecisionDeposit - after the prepare period, DecisionStarted',
      testFn: () => placeDepositAfterPreparePeriod(getClient(), cfg),
    },
  ]
}

/**
 * Cancel and kill tests that every ranked referenda instance runs. Their outcome depends on the
 * instance's `CancelOrigin`, `KillOrigin` and slash destination.
 */
function cancelAndKillTests(getClient: () => Client<any, any>, cfg: RankedReferendaTestConfig): TestNode[] {
  return [
    {
      kind: 'test',
      label: 'cancel - every accepted origin, Cancelled with deposits kept',
      testFn: () => cancelByAcceptedOrigins(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'cancel - other origins - BadOrigin',
      testFn: () => cancelByRejectedOrigins(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'kill - every accepted origin, Killed with deposits slashed',
      testFn: () => killByAcceptedOrigins(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'kill - other origins - BadOrigin',
      testFn: () => killByRejectedOrigins(getClient(), cfg),
    },
  ]
}

/**
 * Refund tests that every ranked referenda instance runs: the refunds after a cancel, whose amounts
 * depend on the instance's deposits.
 */
function refundTests(getClient: () => Client<any, any>, cfg: RankedReferendaTestConfig): TestNode[] {
  return [
    {
      kind: 'test',
      label: 'refunds - after cancel, anyone returns both deposits to the depositors',
      testFn: () => refundsAfterCancel(getClient(), cfg),
    },
  ]
}

/**
 * Lifecycle tests that every ranked referenda instance runs. Their outcome depends on the
 * instance's timeouts, track periods and curves, and the ranked tally.
 */
function lifecycleTests(getClient: () => Client<any, any>, cfg: RankedReferendaTestConfig): TestNode[] {
  return [
    {
      kind: 'test',
      label: 'nudgeReferendum - no decision deposit by the timeout, TimedOut',
      testFn: () => timeOutWithoutDeposit(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'vote - passing tally near the end of the decision period, ConfirmStarted',
      testFn: () => confirmStartsOnPassingTally(getClient(), cfg),
    },
    {
      kind: 'test',
      label: 'nudgeReferendum - confirm period over, Confirmed and enactment scheduled',
      testFn: () => confirmedAndEnactmentScheduled(getClient(), cfg),
    },
  ]
}

/**
 * Test runner for the Fellowship referenda E2E suite on the Collectives chain.
 *
 * Runs the tests shared by every ranked referenda instance, plus the Fellowship-only ones: the
 * allow-list and voice submission arms, and the pallet paths that read no runtime configuration.
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
  testConfig: RankedReferendaTestConfig,
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
        testFn: async () => await fellowshipWhitelistViaReferendum(destClient, collectivesClient),
      },
      {
        kind: 'describe',
        label: 'submission',
        children: [
          ...submissionTests(() => collectivesClient, testConfig),
          {
            kind: 'test',
            label: 'submit - members may open referenda on voice tracks up to their rank',
            testFn: () => submitOnVoiceTracks(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'submit - allow-listed account without rank, Submitted',
            testFn: () => submitFromAllowList(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'submit - preimage noted with another length - PreimageStoredWithDifferentLength',
            testFn: () => submitWithWrongPreimageLength(collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'decision deposit',
        children: [
          ...decisionDepositTests(() => collectivesClient, testConfig),
          {
            kind: 'test',
            label: 'placeDecisionDeposit - already placed - HasDeposit',
            testFn: () => placeDepositTwice(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'placeDecisionDeposit - unknown or finished referendum - NotOngoing',
            testFn: () => placeDepositNotOngoing(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'placeDecisionDeposit - payer cannot cover the deposit - InsufficientBalance',
            testFn: () => placeDepositUnaffordable(collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'cancel and kill',
        children: [
          ...cancelAndKillTests(() => collectivesClient, testConfig),
          {
            kind: 'test',
            label: 'cancel - only a deciding referendum frees a deciding slot',
            testFn: () => cancelFreesOnlyDecidingSlot(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'cancel and kill - finished referendum - NotOngoing',
            testFn: () => cancelOrKillFinished(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'cancel - enacted by a real Architects referendum, Cancelled',
            testFn: () => cancelByRealArchitectsReferendum(collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'refunds',
        children: [
          ...refundTests(() => collectivesClient, testConfig),
          {
            kind: 'test',
            label: 'refundDecisionDeposit - ongoing referendum - Unfinished',
            testFn: () => refundDecisionDepositOngoing(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'refundDecisionDeposit - already refunded or killed - NoDeposit',
            testFn: () => refundDecisionDepositNothingLeft(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'refunds - unknown referendum - BadReferendum',
            testFn: () => refundsUnknownReferendum(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'refundSubmissionDeposit - ongoing or killed - BadStatus',
            testFn: () => refundSubmissionDepositBadStatus(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'refunds - Root accepted, collective origin - BadOrigin',
            testFn: () => refundsByRootAndCollectiveOrigin(collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'lifecycle',
        children: [
          ...lifecycleTests(() => collectivesClient, testConfig),
          {
            kind: 'test',
            label: 'vote - tally stops passing while confirming, ConfirmAborted',
            testFn: () => confirmAbortsWhenTallyFails(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'nudgeReferendum - decision period over without passing, Rejected',
            testFn: () => rejectedAtDecisionEnd(collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'root-only calls',
        children: [
          {
            kind: 'test',
            label: 'wrong origin for signed-only and Root-only calls - BadOrigin',
            testFn: () => wrongOriginForInternalAndSignedCalls(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'nudgeReferendum - finished referendum - NotOngoing',
            testFn: () => nudgeFinishedReferendum(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'oneFewerDeciding - unknown track - BadTrack',
            testFn: () => oneFewerDecidingUnknownTrack(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'oneFewerDeciding - full track, queued referendum starts deciding',
            testFn: () => oneFewerDecidingStartsQueued(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'oneFewerDeciding - empty queue, DecidingCount drops by one',
            testFn: () => oneFewerDecidingEmptyQueue(collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'metadata',
        children: [
          {
            kind: 'test',
            label: 'setMetadata - submitter sets then clears, MetadataSet and MetadataCleared',
            testFn: () => setAndClearMetadata(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'setMetadata - not the submitter - NoPermission',
            testFn: () => metadataByNonSubmitter(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'setMetadata - hash without a preimage - PreimageNotExist',
            testFn: () => metadataWithoutPreimage(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'setMetadata - finished referendum, set fails and anyone may clear',
            testFn: () => metadataAfterReferendumEnds(collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'voting behavior',
        children: [
          {
            kind: 'test',
            label: 'a member below the track rank cannot vote',
            testFn: async () => await rankTooLowCannotVote(collectivesClient),
          },
          {
            kind: 'test',
            label: 'vote weight is geometric in rank',
            testFn: async () => await geometricVoteWeightAggregation(collectivesClient),
          },
          {
            kind: 'test',
            label: 'vote - retention track minimum is its track id minus 8 - RankTooLow',
            testFn: () => retentionTrackMinimumRank(collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'vote - retention track support counts members at its minimum rank, ConfirmStarted',
            testFn: () => retentionSupportCountsMinimumRank(collectivesClient, testConfig),
          },
        ],
      },
    ],
  }
}

/**
 * Test runner for the Ambassador referenda E2E suite on the Collectives chain.
 *
 * Runs the tests shared by every ranked referenda instance against the Ambassador instance.
 *
 * @param assetHubChain Asset Hub, whose `FellowshipAdmin` origin may cancel and kill Ambassador
 *   referenda over XCM.
 * @param collectivesChain The Collectives chain hosting the Ambassador Program.
 */
export function ambassadorReferendaE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesAssetHub extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  assetHubChain: Chain<TCustom, TInitStoragesAssetHub>,
  collectivesChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: RankedReferendaTestConfig,
): RootTestTree {
  let assetHubClient!: Client<TCustom, TInitStoragesAssetHub>
  let collectivesClient!: Client<TCustom, TInitStoragesPara>
  let restoreSnapshot: () => Promise<void>

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[assetHubClient, collectivesClient] = await createNetworks(assetHubChain, collectivesChain)
      restoreSnapshot = captureSnapshot(assetHubClient, collectivesClient)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      for (const c of [assetHubClient, collectivesClient]) {
        const blockNumber = (await c.api.rpc.chain.getHeader()).number.toNumber()
        await c.dev.setHead(blockNumber)
      }
    },
    afterAll: async () => {
      for (const c of [assetHubClient, collectivesClient]) {
        await c.api.disconnect().catch(() => {})
        await c.teardown().catch(() => {})
      }
    },
    children: [
      {
        kind: 'describe',
        label: 'submission',
        children: submissionTests(() => collectivesClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'decision deposit',
        children: decisionDepositTests(() => collectivesClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'cancel and kill',
        children: [
          ...cancelAndKillTests(() => collectivesClient, testConfig),
          {
            kind: 'test',
            label: 'cancel - FellowshipAdmin voice from Asset Hub over XCM, Cancelled',
            testFn: () => cancelByAssetHubFellowshipAdmin(assetHubClient, collectivesClient, testConfig),
          },
          {
            kind: 'test',
            label: 'kill - FellowshipAdmin voice from Asset Hub over XCM, Killed',
            testFn: () => killByAssetHubFellowshipAdmin(assetHubClient, collectivesClient, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'refunds',
        children: refundTests(() => collectivesClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'lifecycle',
        children: lifecycleTests(() => collectivesClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'voting behavior',
        children: [
          {
            kind: 'test',
            label: 'vote - weight by excess rank over the track minimum, RankTooLow below it',
            testFn: () => voteWeightsByExcessRank(collectivesClient, testConfig),
          },
        ],
      },
    ],
  }
}

/**
 * Test runner for the Fellowship referenda E2E suite on a relay chain.
 *
 * Runs the tests shared by every ranked referenda instance against the relay's own Fellowship.
 *
 * @param relayChain The relay chain hosting the Fellowship referenda instance.
 */
export function relayFellowshipReferendaE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStorages>, testConfig: RankedReferendaTestConfig): RootTestTree {
  let relayClient!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[relayClient] = await createNetworks(relayChain)
      restoreSnapshot = captureSnapshot(relayClient)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      const blockNumber = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()
      await relayClient.dev.setHead(blockNumber)
    },
    afterAll: async () => {
      await relayClient.api.disconnect().catch(() => {})
      await relayClient.teardown().catch(() => {})
    },
    children: [
      {
        kind: 'describe',
        label: 'submission',
        children: submissionTests(() => relayClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'decision deposit',
        children: decisionDepositTests(() => relayClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'cancel and kill',
        children: cancelAndKillTests(() => relayClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'refunds',
        children: refundTests(() => relayClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'lifecycle',
        children: lifecycleTests(() => relayClient, testConfig),
      },
      {
        kind: 'describe',
        label: 'voting behavior',
        children: [
          {
            kind: 'test',
            label: 'vote - weight by excess rank over the track minimum, RankTooLow below it',
            testFn: () => voteWeightsByExcessRank(relayClient, testConfig),
          },
        ],
      },
    ],
  }
}
