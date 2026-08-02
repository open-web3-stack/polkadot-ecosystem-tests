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

/// ---------
/// Constants
/// ---------

// The Collectives parachain ID on Polkadot.
export const COLLECTIVES_PARA_ID = 1001

// The pallet index for `pallet-ranked-collective` in the Collectives runtime.
export const FELLOWSHIP_COLLECTIVE_PALLET_INDEX = 60

// The pallet index for `pallet-core-fellowship` in the Collectives runtime.
export const FELLOWSHIP_CORE_PALLET_INDEX = 63

// Default free balance given to synthetic Fellowship members created in focused tests.
export const DEFAULT_SALARY_TEST_FREE_BALANCE = 1_000n * 10n ** 10n

/// ----------------
/// Internal helpers
/// ----------------

/**
 * Relocate the first scheduled call matching `verifier` to the next schedulable block, so it runs
 * immediately instead of at its originally scheduled (future) block.
 *
 * Only the matching entry is moved: its source slot is replaced with `None` (preserving the
 * indices of any sibling tasks in that block), and it is appended to the destination block's
 * existing agenda. On a live fork the agenda holds unrelated governance tasks, so moving the whole
 * vector (or overwriting the destination) would fast-forward or clobber them.
 */
async function moveScheduledCallToNextBlock(
  client: any,
  blockProvider: BlockProvider,
  verifier: (call: any) => boolean,
): Promise<void> {
  const nextBlockNumber = await nextSchedulableBlockNum(client.api, blockProvider)
  const agenda = await client.api.query.scheduler.agenda.entries()

  const agendaVecType = client.api.query.scheduler.agenda.creator.meta.type.asMap.value
  const vecType = client.api.registry.lookup.getTypeDef(agendaVecType).type

  for (const [sourceKey, sourceTasks] of agenda) {
    const sourceArray = [...sourceTasks]
    const matchIndex = sourceArray.findIndex((task) => task.isSome && verifier(task.unwrap().call))
    if (matchIndex === -1) {
      continue
    }

    const matched = sourceArray[matchIndex].unwrap()

    // Append the matched task to the destination block's existing agenda; blank only the matched
    // source slot with `None` so sibling tasks keep their original indices.
    const destArray = [...(await client.api.query.scheduler.agenda(nextBlockNumber))]
    const appendedIndex = destArray.length
    destArray.push(sourceArray[matchIndex])

    const newSourceArray = sourceArray.map((task, i) => (i === matchIndex ? null : task))

    await client.api.rpc('dev_setStorage', [
      [sourceKey, client.api.registry.createType(vecType, newSourceArray).toHex()],
      [
        client.api.query.scheduler.agenda.key(nextBlockNumber),
        client.api.registry.createType(vecType, destArray).toHex(),
      ],
    ])

    // If the task is named, point its lookup at the real destination (block, appended index).
    if (matched.maybeId.isSome) {
      const id = matched.maybeId.unwrap().toHex()
      const lookup = await client.api.query.scheduler.lookup(id)
      if (lookup.isSome) {
        const lookupKey = client.api.query.scheduler.lookup.key(id)
        const lookupValueType = client.api.registry.lookup.getTypeDef(
          client.api.query.scheduler.lookup.creator.meta.type.asMap.value,
        ).type
        const fastLookup = client.api.registry.createType(lookupValueType, [nextBlockNumber, appendedIndex])
        await client.api.rpc('dev_setStorage', [[lookupKey, fastLookup.toHex()]])
      }
    }

    return
  }

  assert(false, 'No scheduled call found')
}

async function findSubmittedReferendumIndex(
  client: any,
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

/// -----------------------
/// Storage writers/seeders
/// -----------------------

/**
 * Seed funded Fellowship members directly into ranked-collective and core-fellowship storage.
 *
 * Seeded members are appended to the live collective rather than replacing it: for each rank tier
 * the existing `memberCount` is read and new members are indexed at `liveCount, liveCount + 1, ...`.
 * This keeps the real electorate (and the ranked-collective index invariants that a later member
 * removal relies on) intact, and means referendum support is measured against the full membership.
 * Consequently a passing referendum must be fast-forwarded to the end of its decision period, where
 * the Fellows track support requirement has decayed to its 0% floor; a single seeded aye does not
 * clear support mid-curve against the real electorate.
 */
export async function seedFellowshipMembers(
  client: any,
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

  // A member of rank R belongs to the collective at every rank tier 0..R, so it is appended to and
  // counted in each of those tiers, starting at the live member count for that tier.
  for (let rank = 0; rank <= maxRank; rank++) {
    const membersAtRank = members.filter((member) => member.rank >= rank)
    const liveCount = ((await client.api.query.fellowshipCollective.memberCount(rank)) as any).toNumber()

    for (const [offset, member] of membersAtRank.entries()) {
      const index = liveCount + offset
      idToIndex.push([[rank, member.pair.address], index])
      indexToId.push([[rank, index], member.pair.address])
    }
    memberCount.push([[rank], liveCount + membersAtRank.length])
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
export function fellowshipCollectiveTx(client: any) {
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
  client: any,
  call: SubmittableExtrinsic<'promise'>,
  track: { FellowshipOrigins: string } | { Origins: string },
  proposer: KeyringPair,
  onBlock?: () => Promise<void>,
): Promise<number> {
  // 1. Clear stale preimages, fund the proposer, and note the proposal preimage

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

  // 2. Submit the referendum and recover its poll index from the matching event

  await sendTransaction(
    client.api.tx.fellowshipReferenda
      .submit(track as any, { Lookup: { hash: preimageHash, len: preimageLength } }, { After: 0 })
      .signAsync(proposer),
  )
  await client.dev.newBlock()

  const referendumIndex = await findSubmittedReferendumIndex(client, preimageHash, preimageLength)
  await onBlock?.()

  // 3. Place the decision deposit so the referendum can enter deciding

  await sendTransaction(client.api.tx.fellowshipReferenda.placeDecisionDeposit(referendumIndex).signAsync(proposer))
  await client.dev.newBlock()
  await onBlock?.()

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
 *
 * Returns the poll index and the `fellowshipReferenda`/`fellowshipCollective` lifecycle events
 * accumulated across the submit, vote, and confirmation blocks, so callers can snapshot the real
 * referendum path.
 */
export async function passFellowshipReferendum(
  client: any,
  call: SubmittableExtrinsic<'promise'>,
  opts: {
    track: { FellowshipOrigins: string } | { Origins: string }
    voters: KeyringPair[]
  },
): Promise<{ referendumIndex: number; lifecycleEvents: any[] }> {
  const blockProvider = client.config.properties.schedulerBlockProvider

  assert(opts.voters.length > 0, 'passFellowshipReferendum requires at least one seeded fellow to submit and vote')
  const proposer = opts.voters[0]

  const lifecycleEvents: any[] = []
  const collectLifecycle = async () => {
    for (const { event } of await client.api.query.system.events()) {
      if (event.section === 'fellowshipReferenda' || event.section === 'fellowshipCollective') {
        lifecycleEvents.push({ section: event.section, method: event.method, data: event.data.toJSON() })
      }
    }
  }

  // 1. Submit the referendum and place its decision deposit

  const referendumIndex = await submitFellowshipReferendum(client, call, opts.track, proposer, collectLifecycle)

  // 2. Cast real aye votes from the seeded Fellowship members

  const collective = fellowshipCollectiveTx(client)
  for (const voter of opts.voters) {
    await sendTransaction(collective.vote(referendumIndex, true).signAsync(voter))
  }
  await client.dev.newBlock()
  await collectLifecycle()

  // 3. Backdate timing-only referendum fields, preserving the real tally, then schedule a nudge

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

  // 4. Move the nudge and enactment tasks to the next block so approval and execution are immediate

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

  await collectLifecycle()

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
  await collectLifecycle()

  return { referendumIndex, lifecycleEvents }
}
