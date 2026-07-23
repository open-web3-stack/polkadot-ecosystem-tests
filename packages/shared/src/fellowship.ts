import { sendTransaction } from '@acala-network/chopsticks-testing'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'

import { assert } from 'vitest'

import {
  type BlockProvider,
  getBlockNumber,
  nextSchedulableBlockNum,
  scheduleInlineCallWithOrigin,
} from './helpers/index.js'
import type { Client } from './types.js'

type AnyClient = Client<Record<string, unknown> | undefined, Record<string, Record<string, any>> | undefined>

/// -------
/// Constants
/// -------

// The Collectives parachain ID on Polkadot.
export const COLLECTIVES_PARA_ID = 1001

// The pallet index for `pallet-ranked-collective` in the Collectives runtime.
export const FELLOWSHIP_COLLECTIVE_PALLET_INDEX = 60

// The pallet index for `pallet-core-fellowship` in the Collectives runtime.
export const FELLOWSHIP_CORE_PALLET_INDEX = 63

// The Dan-3 Fellowship rank used throughout salary-oriented fellowship tests.
export const SALARY_MEMBER_RANK_DAN_3 = 3

// Default free balance given to synthetic Fellowship members created in focused tests.
export const DEFAULT_SALARY_TEST_FREE_BALANCE = 1_000n * 10n ** 10n

/// -------
/// Internal helpers
/// -------

/**
 * Relocate the first scheduled call matching `verifier` to the next schedulable block, so it runs
 * immediately instead of at its originally scheduled (future) block.
 */
async function moveScheduledCallToNextBlock(
  client: AnyClient,
  blockProvider: BlockProvider,
  verifier: (call: any) => boolean,
): Promise<void> {
  const nextBlockNumber = await nextSchedulableBlockNum(client.api, blockProvider)
  const agenda = await client.api.query.scheduler.agenda.entries()
  let found = false

  for (const agendaEntry of agenda) {
    for (const scheduledEntry of agendaEntry[1]) {
      if (scheduledEntry.isSome && verifier(scheduledEntry.unwrap().call)) {
        found = true

        await client.api.rpc('dev_setStorage', [
          [agendaEntry[0]],
          [client.api.query.scheduler.agenda.key(nextBlockNumber), agendaEntry[1].toHex()],
        ])

        if (scheduledEntry.unwrap().maybeId.isSome) {
          const id = scheduledEntry.unwrap().maybeId.unwrap().toHex()
          const lookup = await client.api.query.scheduler.lookup(id)

          if (lookup.isSome) {
            const lookupKey = client.api.query.scheduler.lookup.key(id)
            const lookupMeta = client.api.query.scheduler.lookup.creator.meta
            const lookupValueType = client.api.registry.lookup.getTypeDef(lookupMeta.type.asMap.value).type
            const fastLookup = client.api.registry.createType(lookupValueType, [nextBlockNumber, 0])
            await client.api.rpc('dev_setStorage', [[lookupKey, fastLookup.toHex()]])
          }
        }
      }
    }
  }

  assert(found, 'No scheduled call found')
}

async function findSubmittedReferendumIndex(
  client: AnyClient,
  preimageHash: `0x${string}`,
  preimageLength: number,
): Promise<number> {
  // Match on the `Submitted` event's own proposal, not a storage re-read, to isolate our
  // submission from live fork referenda in the same block. Compare against `toJSON()`: typed
  // indexed access into the `Bounded` proposal mis-decodes the lookup hash.
  const matchingIndices: number[] = []
  for (const { event } of await client.api.query.system.events()) {
    if (event.section !== 'fellowshipReferenda' || event.method !== 'Submitted') {
      continue
    }

    const [index, , proposal] = event.data.toJSON() as [number, number, { lookup?: { hash: string; len: number } }]
    if (proposal.lookup && proposal.lookup.hash === preimageHash && proposal.lookup.len === preimageLength) {
      matchingIndices.push(index)
    }
  }

  assert(
    matchingIndices.length === 1,
    `expected exactly 1 matching fellowship referendum submission, got ${matchingIndices.length}`,
  )

  return matchingIndices[0]
}

/// -------
/// Storage writers/seeders
/// -------

/** Seed funded Fellowship members directly into ranked-collective and core-fellowship storage. */
export async function seedFellowshipMembers(
  client: AnyClient,
  members: { pair: KeyringPair; rank: number }[],
  freeBalance: bigint = DEFAULT_SALARY_TEST_FREE_BALANCE,
): Promise<void> {
  if (members.length === 0) {
    return
  }

  const maxRank = Math.max(...members.map(({ rank }) => rank))
  const memberCount: Array<[[number], number]> = []
  const idToIndex: Array<[[number, string], number]> = []
  const indexToId: Array<[[number, number], string]> = []

  // A member of rank R belongs to the collective at every rank tier 0..R, so it is counted and
  // indexed in each of those tiers.
  for (let rank = 0; rank <= maxRank; rank++) {
    const membersAtRank = members.filter((member) => member.rank >= rank)
    memberCount.push([[rank], membersAtRank.length])

    for (const [index, member] of membersAtRank.entries()) {
      idToIndex.push([[rank, member.pair.address], index])
      indexToId.push([[rank, index], member.pair.address])
    }
  }

  await client.dev.setStorage({
    System: {
      account: members.map(({ pair }) => [
        [pair.address],
        { providers: 1, data: { free: freeBalance, frozen: 0, reserved: 0 } },
      ]),
    },
    FellowshipCollective: {
      members: members.map(({ pair, rank }) => [[pair.address], { rank }]),
      memberCount,
      idToIndex,
      indexToId,
    },
    FellowshipCore: {
      member: members.map(({ pair }) => [[pair.address], { isActive: true, lastPromotion: 0, lastProof: 0 }]),
    },
  })
}

/**
 * Resolve the ranked-collective pallet tx section.
 *
 * It is exposed as `fellowshipCollective` on the Collectives runtime (a `pallet_ranked_collective`
 * instance) and as `rankedCollective` on some other runtimes.
 */
export function fellowshipCollectiveTx(client: AnyClient) {
  const collective = client.api.tx.fellowshipCollective ?? client.api.tx.rankedCollective
  assert(collective, 'no fellowship/ranked collective pallet found')
  return collective
}

/**
 * Submit a Fellowship referendum and place its decision deposit, returning the poll index.
 *
 * The Fellowship referenda `SubmitOrigin` requires a rank-3+ member, so `proposer` must be a
 * seeded fellow rather than a generic dev account.
 *
 * 1. Clear stale preimages, fund the proposer, and note the proposal preimage
 * 2. Submit the referendum and recover its poll index from the matching event
 * 3. Place the decision deposit so the referendum can enter deciding
 */
export async function submitFellowshipReferendum(
  client: AnyClient,
  call: SubmittableExtrinsic<'promise'>,
  track: { FellowshipOrigins: string } | { Origins: string },
  proposer: KeyringPair,
): Promise<number> {
  /**
   * 1. Clear stale preimages, fund the proposer, and note the proposal preimage
   */

  await client.dev.setStorage({
    Preimage: {
      $removePrefix: ['preimageFor', 'statusFor', 'requestStatusFor'],
    },
    System: {
      account: [[[proposer.address], { providers: 1, data: { free: 100_000n * 10n ** 10n, frozen: 0, reserved: 0 } }]],
    },
  })

  const preimageCall = call.method
  const preimageHash = preimageCall.hash.toHex() as `0x${string}`
  const preimageLength = preimageCall.encodedLength

  await sendTransaction(client.api.tx.preimage.notePreimage(preimageCall.toHex()).signAsync(proposer))
  await client.dev.newBlock()

  /**
   * 2. Submit the referendum and recover its poll index from the matching event
   */

  await sendTransaction(
    client.api.tx.fellowshipReferenda
      .submit(track as any, { Lookup: { hash: preimageHash, len: preimageLength } }, { After: 0 })
      .signAsync(proposer),
  )
  await client.dev.newBlock()

  const referendumIndex = await findSubmittedReferendumIndex(client, preimageHash, preimageLength)

  /**
   * 3. Place the decision deposit so the referendum can enter deciding
   */

  await sendTransaction(client.api.tx.fellowshipReferenda.placeDecisionDeposit(referendumIndex).signAsync(proposer))
  await client.dev.newBlock()

  return referendumIndex
}

/**
 * Submit, vote on, fast-forward, and enact a Fellowship referendum without waiting real time.
 *
 * Real votes are cast into the live ranked collective tally. Only the referendum clock is edited.
 *
 * 1. Submit the referendum and place its decision deposit (see `submitFellowshipReferendum`)
 * 2. Cast real aye votes from the seeded Fellowship members
 * 3. Backdate timing-only referendum fields, preserving the real tally, then schedule a nudge
 * 4. Move the nudge and enactment tasks to the next block so approval and execution are immediate
 */
export async function passFellowshipReferendum(
  client: AnyClient,
  call: SubmittableExtrinsic<'promise'>,
  opts: {
    track: { FellowshipOrigins: string } | { Origins: string }
    voters: KeyringPair[]
  },
): Promise<number> {
  const blockProvider = client.config.properties.schedulerBlockProvider

  assert(opts.voters.length > 0, 'passFellowshipReferendum requires at least one seeded fellow to submit and vote')
  const proposer = opts.voters[0]

  /**
   * 1. Submit the referendum and place its decision deposit
   */

  const referendumIndex = await submitFellowshipReferendum(client, call, opts.track, proposer)

  /**
   * 2. Cast real aye votes from the seeded Fellowship members
   */

  const collective = fellowshipCollectiveTx(client)
  for (const voter of opts.voters) {
    await sendTransaction(collective.vote(referendumIndex, true).signAsync(voter))
  }
  await client.dev.newBlock()

  /**
   * 3. Backdate timing-only referendum fields, preserving the real tally, then schedule a nudge
   */

  const referendumInfo = (await client.api.query.fellowshipReferenda.referendumInfoFor(referendumIndex)) as any
  assert(referendumInfo.isSome, `referendum ${referendumIndex} not found after submission, deposit, and voting`)

  const referendumData = referendumInfo.unwrap()
  assert(referendumData.isOngoing, `referendum ${referendumIndex} is not ongoing after voting`)

  const ongoing = referendumData.asOngoing
  const tracks = client.api.consts.fellowshipReferenda.tracks as unknown as any[]
  const track = tracks.find((entry: any) => entry[0].toNumber() === ongoing.track.toNumber())
  assert(track, `track ${ongoing.track.toString()} not found in fellowship referenda runtime constants`)

  const currentBlock = await getBlockNumber(client.api, blockProvider)
  const preparePeriod = track[1].preparePeriod.toNumber()
  const decisionPeriod = track[1].decisionPeriod.toNumber()
  const confirmPeriod = track[1].confirmPeriod.toNumber()
  const decidingSince = currentBlock + 1 - decisionPeriod
  const confirmingSince = currentBlock + 1 - confirmPeriod
  const newSubmitted = decidingSince - preparePeriod

  const referendumKey = client.api.query.fellowshipReferenda.referendumInfoFor.key(referendumIndex)
  const referendumMeta = client.api.query.fellowshipReferenda.referendumInfoFor.creator.meta
  const referendumValueType = client.api.registry.lookup.getTypeDef(referendumMeta.type.asMap.value).type
  const injectedReferendum = client.api.registry.createType(referendumValueType, {
    ongoing: {
      ...ongoing.toJSON(),
      submitted: newSubmitted,
      deciding: {
        since: decidingSince,
        confirming: confirmingSince,
      },
      tally: ongoing.tally.toJSON(),
      alarm: [currentBlock + 1, [currentBlock + 1, 0]],
    },
  })

  await client.api.rpc('dev_setStorage', [[referendumKey, injectedReferendum.toHex()]])

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.fellowshipReferenda.nudgeReferendum(referendumIndex).method.toHex(),
    { system: 'Root' },
    blockProvider,
  )

  /**
   * 4. Move the nudge and enactment tasks to the next block so approval and execution are immediate
   */

  const callHash = ongoing.proposal.isLookup
    ? ongoing.proposal.asLookup.hash.toHex()
    : ongoing.proposal.isInline
      ? client.api.registry.hash(ongoing.proposal.asInline).toHex()
      : ongoing.proposal.asLegacy.hash.toHex()

  await moveScheduledCallToNextBlock(client, blockProvider, (scheduledCall) => {
    if (!scheduledCall.isInline) {
      return false
    }

    const callData = client.api.createType('Call', scheduledCall.asInline.toHex())
    return callData.method === 'nudgeReferendum' && (callData.args[0] as any).toNumber() === referendumIndex
  })
  await client.dev.newBlock()

  const postNudgeInfo = (await client.api.query.fellowshipReferenda.referendumInfoFor(referendumIndex)) as any
  assert(postNudgeInfo.isSome, `referendum ${referendumIndex} disappeared after nudging`)
  assert(
    postNudgeInfo.unwrap().isApproved || postNudgeInfo.unwrap().isConfirmed,
    `referendum ${referendumIndex} did not reach approved or confirmed state after nudging`,
  )

  await moveScheduledCallToNextBlock(client, blockProvider, (scheduledCall) => {
    return scheduledCall.isLookup
      ? scheduledCall.asLookup.hash.toHex() === callHash
      : scheduledCall.isInline
        ? client.api.registry.hash(scheduledCall.asInline).toHex() === callHash
        : scheduledCall.asLegacy.hash.toHex() === callHash
  })

  await client.dev.newBlock()

  return referendumIndex
}
