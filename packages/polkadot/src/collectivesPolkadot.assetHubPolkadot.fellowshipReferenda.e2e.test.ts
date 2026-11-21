import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { fellowshipReferendaE2ETests, type RankedReferendaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RankedReferendaTestConfig = {
  testSuiteName: 'Polkadot Fellowship referenda',
  referenda: 'fellowshipReferenda',
  collective: 'fellowshipCollective',
  collectiveStorage: 'FellowshipCollective',
  // `SubmitOrigin` accepts any member of rank 3 (Fellows) or above on every track; track 9 is the
  // highest regular track.
  submitAnyTrack: { rank: 3, track: { id: 9, origin: { FellowshipOrigins: 'Fellowship9Dan' } } },
  rejectedSubmitters: [
    // Below rank 3, a member may submit only on voice tracks up to its own rank.
    { rank: 2, track: { id: 3, origin: { FellowshipOrigins: 'Fellows' } } },
    // A non-member outside the `AllowedProposers` list may not submit at all.
    { track: { id: 1, origin: { FellowshipOrigins: 'Members' } } },
  ],
  // The Fellows track: 150-block prepare period, 10 deciding slots.
  track: { id: 3, origin: { FellowshipOrigins: 'Fellows' } },
  // Regular tracks 1-9 take their id as the minimum voting rank.
  trackMinRank: 3,
  // `CancelOrigin` is `Architects` alone and `KillOrigin` is `Masters` alone. Neither accepts Root,
  // and a higher voice cannot stand in: `Masters` cannot cancel, `Fellowship9Dan` cannot kill.
  cancelOrigins: {
    accepted: [{ FellowshipOrigins: 'Architects' }],
    rejected: [{ system: 'Root' }, { FellowshipOrigins: 'Masters' }, { FellowshipOrigins: 'Fellows' }],
  },
  killOrigins: {
    accepted: [{ FellowshipOrigins: 'Masters' }],
    rejected: [{ system: 'Root' }, { FellowshipOrigins: 'Architects' }, { FellowshipOrigins: 'Fellowship9Dan' }],
  },
  // `ToParentTreasury` teleports slashed deposits to the relay chain's treasury account.
  slashDestination: 'relayTreasury',
}

registerTestTree(fellowshipReferendaE2ETests(assetHubPolkadot, collectivesPolkadot, testConfig))
