import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { ambassadorReferendaE2ETests, type RankedReferendaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RankedReferendaTestConfig = {
  testSuiteName: 'Polkadot Ambassador referenda',
  referenda: 'ambassadorReferenda',
  collective: 'ambassadorCollective',
  collectiveStorage: 'AmbassadorCollective',
  // `SubmitOrigin` accepts any member of rank 1 (Ambassador) or above on every track; track 3
  // (Head Ambassadors) is the highest.
  submitAnyTrack: { rank: 1, track: { id: 3, origin: { AmbassadorOrigins: 'HeadAmbassadors' } } },
  rejectedSubmitters: [
    // A rank-0 candidate is a member, but below the rank `SubmitOrigin` requires.
    { rank: 0, track: { id: 1, origin: { AmbassadorOrigins: 'Ambassadors' } } },
    // A non-member may not submit at all.
    { track: { id: 1, origin: { AmbassadorOrigins: 'Ambassadors' } } },
  ],
  // The Ambassadors track: 7200-block prepare period, 10 deciding slots.
  track: { id: 1, origin: { AmbassadorOrigins: 'Ambassadors' } },
  // `MinRankOfClass` is the identity: the track id is the minimum voting rank.
  trackMinRank: 1,
  // `CancelOrigin` and `KillOrigin` are both Root, `HeadAmbassadors`, or the `FellowshipAdmin` voice
  // of the relay chain or Asset Hub. The Asset Hub voice arrives over XCM and has its own test.
  cancelOrigins: {
    accepted: [{ system: 'Root' }, { AmbassadorOrigins: 'HeadAmbassadors' }],
    rejected: [{ AmbassadorOrigins: 'SeniorAmbassadors' }, { AmbassadorOrigins: 'Ambassadors' }],
  },
  killOrigins: {
    accepted: [{ system: 'Root' }, { AmbassadorOrigins: 'HeadAmbassadors' }],
    rejected: [{ AmbassadorOrigins: 'SeniorAmbassadors' }],
  },
  // `ToParentTreasury` teleports slashed deposits to the relay chain's treasury account.
  slashDestination: 'relayTreasury',
  // Ambassador `VoteWeight`: excess rank 0 weighs 1, and every further rank 5 more. `MinRankOfClass`
  // is the identity, so on track 1 a rank-0 candidate is below the minimum.
  voteWeights: {
    track: { id: 1, origin: { AmbassadorOrigins: 'Ambassadors' } },
    belowRank: 0,
    voters: [
      { rank: 1, weight: 1 },
      { rank: 2, weight: 5 },
      { rank: 3, weight: 10 },
    ],
  },
}

registerTestTree(ambassadorReferendaE2ETests(assetHubPolkadot, collectivesPolkadot, testConfig))
