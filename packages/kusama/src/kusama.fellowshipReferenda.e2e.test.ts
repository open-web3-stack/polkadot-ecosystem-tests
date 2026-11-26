import { kusama } from '@e2e-test/networks/chains'
import { type RankedReferendaTestConfig, registerTestTree, relayFellowshipReferendaE2ETests } from '@e2e-test/shared'

const testConfig: RankedReferendaTestConfig = {
  testSuiteName: 'Kusama Fellowship referenda',
  referenda: 'fellowshipReferenda',
  collective: 'fellowshipCollective',
  collectiveStorage: 'FellowshipCollective',
  // `SubmitOrigin` accepts any member of rank 1 or above on every track; track 9 is the highest.
  submitAnyTrack: { rank: 1, track: { id: 9, origin: { Origins: 'Fellowship9Dan' } } },
  rejectedSubmitters: [
    // A rank-0 candidate is a member, but below the rank `SubmitOrigin` requires.
    { rank: 0, track: { id: 0, origin: { Origins: 'FellowshipInitiates' } } },
    // A non-member may not submit at all.
    { track: { id: 1, origin: { Origins: 'Fellowship1Dan' } } },
  ],
  // The members track: 300-block prepare period, 10 deciding slots.
  track: { id: 1, origin: { Origins: 'Fellowship1Dan' } },
  // `MinRankOfClass` is the identity: the track id is the minimum voting rank.
  trackMinRank: 1,
  // `CancelOrigin` is `FellowshipExperts` alone and `KillOrigin` is `FellowshipMasters` alone.
  // Neither accepts Root, and `Fellowship5Dan`, which shares track 5 with `FellowshipExperts`,
  // cannot cancel.
  cancelOrigins: {
    accepted: [{ Origins: 'FellowshipExperts' }],
    rejected: [{ system: 'Root' }, { Origins: 'FellowshipMasters' }, { Origins: 'Fellowship5Dan' }],
  },
  killOrigins: {
    accepted: [{ Origins: 'FellowshipMasters' }],
    rejected: [{ system: 'Root' }, { Origins: 'FellowshipExperts' }],
  },
  // Slashed deposits are paid into the relay chain's own treasury pot.
  slashDestination: 'treasury',
  // `Geometric` `VoteWeight`: excess rank e weighs (e + 1)(e + 2) / 2. `MinRankOfClass` is the
  // identity, so on track 3 a rank-2 member is below the minimum.
  voteWeights: {
    track: { id: 3, origin: { Origins: 'Fellowship3Dan' } },
    belowRank: 2,
    voters: [
      { rank: 3, weight: 1 },
      { rank: 4, weight: 3 },
      { rank: 5, weight: 6 },
    ],
  },
}

registerTestTree(relayFellowshipReferendaE2ETests(kusama, testConfig))
