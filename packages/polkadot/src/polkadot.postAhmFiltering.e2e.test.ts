import { polkadot } from '@e2e-test/networks/chains'
import {
  auctionsCallsFilteredTest,
  babeCallsNotFilteredTest,
  beefyCallsNotFilteredTest,
  bountiesCallsFilteredTest,
  childBountiesCallsFilteredTest,
  convictionVotingCallsFilteredTest,
  coretimeCallsNotFilteredTest,
  crowdloanCallsFilteredTest,
  crowdloanCallsNotFilteredTest,
  grandpaCallsNotFilteredTest,
  nominationPoolsCallsFilteredTest,
  type PostAhmTest,
  parasCallsNotFilteredTest,
  parasSlashingCallsNotFilteredTest,
  postAhmFilteringE2ETests,
  preimageCallsFilteredTest,
  type RelayTestConfig,
  referendaCallsFilteredTest,
  registerTestTree,
  schedulerCallsFilteredTest,
  slotsCallsFilteredTest,
  stakingAhClientCallsNotFilteredTest,
  stakingCallsFilteredTest,
  systemCallsNotFilteredTest,
  treasuryCallsFilteredTest,
  vestingCallsFilteredTest,
} from '@e2e-test/shared'

const polkadotTestConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Post-AHM Filtering Tests',
  addressEncoding: 0,
  blockProvider: 'Local',
}

// Polkadot: preimage calls ARE filtered post-AHM
const filteredTests: PostAhmTest[] = [
  { label: 'staking calls are filtered', testFn: stakingCallsFilteredTest },
  { label: 'vesting calls are filtered', testFn: vestingCallsFilteredTest },
  { label: 'referenda calls are filtered', testFn: referendaCallsFilteredTest },
  { label: 'conviction-voting calls are filtered', testFn: convictionVotingCallsFilteredTest },
  { label: 'preimage calls are filtered', testFn: preimageCallsFilteredTest },
  { label: 'nomination pools calls are filtered', testFn: nominationPoolsCallsFilteredTest },
  { label: 'bounties calls are filtered', testFn: bountiesCallsFilteredTest },
  { label: 'child-bounties calls are filtered', testFn: childBountiesCallsFilteredTest },
  { label: 'slots calls are filtered', testFn: slotsCallsFilteredTest },
  { label: 'auctions calls are filtered', testFn: auctionsCallsFilteredTest },
  { label: 'crowdloan calls (create, contribute, edit, etc) are filtered', testFn: crowdloanCallsFilteredTest },
  { label: 'scheduler calls are filtered', testFn: schedulerCallsFilteredTest },
  { label: 'treasury calls are filtered', testFn: treasuryCallsFilteredTest },
]

const unfilteredTests: PostAhmTest[] = [
  { label: 'babe calls are not filtered', testFn: babeCallsNotFilteredTest },
  { label: 'grandpa calls are not filtered', testFn: grandpaCallsNotFilteredTest },
  { label: 'beefy calls are not filtered', testFn: beefyCallsNotFilteredTest },
  { label: 'parasSlashing calls are not filtered', testFn: parasSlashingCallsNotFilteredTest },
  { label: 'crowdloan calls (withdraw, refund, dissolve) are not filtered', testFn: crowdloanCallsNotFilteredTest },
  { label: 'system calls are not filtered', testFn: systemCallsNotFilteredTest },
  { label: 'stakingAhClient calls are not filtered', testFn: stakingAhClientCallsNotFilteredTest },
  { label: 'paras calls are not filtered', testFn: parasCallsNotFilteredTest },
  { label: 'coretime calls are not filtered', testFn: coretimeCallsNotFilteredTest },
]

registerTestTree(postAhmFilteringE2ETests(polkadot, polkadotTestConfig, filteredTests, unfilteredTests))
