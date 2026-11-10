import { sendTransaction } from '@acala-network/chopsticks-testing'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import { u8aToHex } from '@polkadot/util'

import { assert } from 'vitest'

import { assertExpectedEvents, type BlockProvider, getBlockNumber, nextSchedulableBlockNum } from './helpers/index.js'

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
 * Seeded members are appended to the live collective, not swapped in for it: for each rank tier
 * the existing `memberCount` is read and new members are indexed at `liveCount, liveCount + 1, ...`.
 * The real electorate and the ranked-collective per-tier index invariants are left intact.
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
 * Submit a Fellowship referendum and place its decision deposit, returning the poll index.
 *
 * The Fellowship referenda `SubmitOrigin` requires a rank-3+ member, so `proposer` must be a
 * seeded fellow rather than a generic dev account.
 *
 * 1. Fund the proposer and note the proposal preimage (unless already noted)
 * 2. Submit the referendum, recover its poll index, and assert the Submitted event's payload
 * 3. Place the decision deposit and assert the DecisionDepositPlaced event
 */
export async function submitFellowshipReferendum(
  client: any,
  call: SubmittableExtrinsic<'promise'>,
  track: { FellowshipOrigins: string } | { Origins: string },
  proposer: KeyringPair,
): Promise<number> {
  // 1. Fund the proposer and note the proposal preimage (skip if already noted).

  await client.dev.setStorage({
    System: {
      account: [[[proposer.address], { providers: 1, data: { free: 100_000n * 10n ** 10n, frozen: 0, reserved: 0 } }]],
    },
  })

  const preimageCall = call.method
  const preimageHash = preimageCall.hash.toHex() as `0x${string}`
  const preimageLength = preimageCall.encodedLength

  const existingPreimageStatus = (await client.api.query.preimage.requestStatusFor(preimageHash)) as any
  if (existingPreimageStatus.isNone) {
    await sendTransaction(client.api.tx.preimage.notePreimage(preimageCall.toHex()).signAsync(proposer))
    await client.dev.newBlock()
  }

  // 2. Submit the referendum, recover its poll index from the matching event, and assert the
  // Submitted event carries the expected track and lookup proposal.

  await sendTransaction(
    client.api.tx.fellowshipReferenda
      .submit(track as any, { Lookup: { hash: preimageHash, len: preimageLength } }, { After: 0 })
      .signAsync(proposer),
  )
  await client.dev.newBlock()

  const referendumIndex = await findSubmittedReferendumIndex(client, preimageHash, preimageLength)

  // Scrutinize the Submitted event's payload for our index, track, and lookup proposal. We read the
  // raw JSON tuple `[index, track, proposal]` rather than typed indexed access, because PJS
  // mis-decodes the `Bounded` proposal wrapper's lookup hash.
  const submitEvents = await client.api.query.system.events()
  const submittedTuple = submitEvents
    .filter(({ event }: any) => client.api.events.fellowshipReferenda.Submitted.is(event))
    .map(({ event }: any) => event.data.toJSON() as [number, number, { lookup?: { hash: string; len: number } }])
    .find((data) => data[0] === referendumIndex)
  assert(submittedTuple, `Submitted event for referendum ${referendumIndex} not found`)
  const submittedProposal = submittedTuple[2].lookup
  assert(submittedProposal, `Submitted event proposal is not a Lookup for referendum ${referendumIndex}`)
  assert(
    submittedProposal.hash === preimageHash,
    `Submitted proposal hash ${submittedProposal.hash} != expected ${preimageHash}`,
  )
  assert(
    submittedProposal.len === preimageLength,
    `Submitted proposal len ${submittedProposal.len} != expected ${preimageLength}`,
  )

  // 3. Place the decision deposit so the referendum can enter deciding, and assert the pallet
  // records the deposit against our proposer.

  await sendTransaction(client.api.tx.fellowshipReferenda.placeDecisionDeposit(referendumIndex).signAsync(proposer))
  await client.dev.newBlock()

  // Match the depositor by public key: chain events render `AccountId` under the runtime's SS58
  // prefix (0 for Polkadot), while `KeyringPair.address` uses the keyring's default (42), so a
  // direct string compare fails despite identical accounts.
  const proposerPubKey = u8aToHex(proposer.publicKey)
  assertExpectedEvents(await client.api.query.system.events(), [
    {
      type: client.api.events.fellowshipReferenda.DecisionDepositPlaced,
      args: {
        index: referendumIndex,
        who: (who: any) => u8aToHex((who as any).toU8a?.() ?? who) === proposerPubKey,
      },
    },
  ])

  return referendumIndex
}

/**
 * Submit, vote on, fast-forward, and enact a Fellowship referendum without waiting real time.
 *
 * Real votes are cast into the live ranked collective tally. Only the referendum clock is edited.
 *
 * Support is measured against the full merged electorate (see `seedFellowshipMembers`), so the
 * referendum is fast-forwarded to the end of its decision period, where the Fellows track support
 * requirement has decayed to its 0% floor. A single seeded aye clears support only there, not
 * mid-curve.
 *
 * Asserts each lifecycle event as it is emitted: `Submitted` and `DecisionDepositPlaced` in
 * `submitFellowshipReferendum`, then `Voted` and `Confirmed` here.
 *
 * 1. Submit the referendum and place its decision deposit (see `submitFellowshipReferendum`)
 * 2. Cast real aye votes from the seeded Fellowship members
 * 3. Backdate timing-only referendum fields, preserving the real tally, then append a nudge
 * 4. Execute the nudge to confirm the poll, then relocate the enactment task so it runs immediately
 */
export async function passFellowshipReferendum(
  client: any,
  call: SubmittableExtrinsic<'promise'>,
  opts: {
    track: { FellowshipOrigins: string } | { Origins: string }
    voters: KeyringPair[]
  },
): Promise<number> {
  const blockProvider = client.config.properties.schedulerBlockProvider

  assert(opts.voters.length > 0, 'passFellowshipReferendum requires at least one seeded fellow to submit and vote')
  const proposer = opts.voters[0]

  // 1. Submit the referendum and place its decision deposit

  const referendumIndex = await submitFellowshipReferendum(client, call, opts.track, proposer)

  // 2. Cast real aye votes from the seeded Fellowship members, and assert one Voted event per
  // voter carrying that voter's public key and an Aye vote against our referendum index.

  for (const voter of opts.voters) {
    await sendTransaction(client.api.tx.fellowshipCollective.vote(referendumIndex, true).signAsync(voter))
  }
  await client.dev.newBlock()

  assertExpectedEvents(
    await client.api.query.system.events(),
    opts.voters.map((voter) => {
      const voterPubKey = u8aToHex(voter.publicKey)
      return {
        type: client.api.events.fellowshipCollective.Voted,
        args: {
          poll: referendumIndex,
          who: (who: any) => u8aToHex((who as any).toU8a?.() ?? who) === voterPubKey,
          vote: (vote: any) => vote.isAye,
        },
      }
    }),
  )

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

  // Append a Root-origin nudge for our referendum to the next schedulable block's agenda,
  // preserving any tasks the live fork has already scheduled there.
  const nudgeBlockNumber = await nextSchedulableBlockNum(client.api, blockProvider)
  const nudgeCall = { Inline: client.api.tx.fellowshipReferenda.nudgeReferendum(referendumIndex).method.toHex() }
  const nudgeScheduled = {
    maybeId: null,
    priority: 128,
    call: nudgeCall,
    maybePeriodic: null,
    origin: { system: 'Root' },
  }
  const nudgeAgendaVecType = client.api.registry.lookup.getTypeDef(
    client.api.query.scheduler.agenda.creator.meta.type.asMap.value,
  ).type
  const existingNudgeAgenda = [...(await client.api.query.scheduler.agenda(nudgeBlockNumber))]
  existingNudgeAgenda.push(nudgeScheduled as any)
  await client.api.rpc('dev_setStorage', [
    [
      client.api.query.scheduler.agenda.key(nudgeBlockNumber),
      client.api.registry.createType(nudgeAgendaVecType, existingNudgeAgenda).toHex(),
    ],
  ])

  // 4. Advance one block to execute the nudge, then relocate the enactment task forward.

  const callHash = ongoing.proposal.isLookup
    ? ongoing.proposal.asLookup.hash.toHex()
    : ongoing.proposal.isInline
      ? client.api.registry.hash(ongoing.proposal.asInline).toHex()
      : ongoing.proposal.asLegacy.hash.toHex()

  await client.dev.newBlock()

  // Assert the runtime confirmed our poll (not some other live-fork referendum in the same block).
  assertExpectedEvents(await client.api.query.system.events(), [
    { type: client.api.events.fellowshipReferenda.Confirmed, args: { index: referendumIndex } },
  ])

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
