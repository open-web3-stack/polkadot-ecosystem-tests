import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, type GovernanceTestConfig, registerTestTree } from '@e2e-test/shared'

// Tracks selected by referendum volume (Polkassembly, all-time) + criticality.
// Only one track is active: the per-track tests are identical in logic and each takes ~15 s,
// so running every track is repetitive. Uncomment additional tracks as needed.
const governanceConfig: GovernanceTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Governance',
  tracks: [
    // --- high-volume tracks (by referendum count) ---
    //{ trackId: 33, trackName: 'medium_spender', originName: 'MediumSpender' }, //  609 refs (32.7 %)
    //{ trackId: 32, trackName: 'small_spender', originName: 'SmallSpender' }, //    275 refs (14.8 %)
    //{ trackId: 30, trackName: 'small_tipper', originName: 'SmallTipper' }, //      235 refs (12.6 %)
    { trackId: 34, trackName: 'big_spender', originName: 'BigSpender' }, //          173 refs  (9.3 %)
    //{ trackId: 31, trackName: 'big_tipper', originName: 'BigTipper' }, //          153 refs  (8.2 %)
    // --- critical tracks (low volume, high impact) ---
    { trackId: 0, trackName: 'root', originName: 'Root', systemOrigin: true }, //   59 refs  (3.2 %)
    //{ trackId: 1, trackName: 'whitelisted_caller', originName: 'WhitelistedCaller' }, // 106 refs (5.7 %)
    //{ trackId: 20, trackName: 'referendum_canceller', originName: 'ReferendumCanceller' }, // 27 refs (1.4 %)
    { trackId: 21, trackName: 'referendum_killer', originName: 'ReferendumKiller' }, //      6 refs (0.3 %)
  ],
}

registerTestTree(baseGovernanceE2ETests(assetHubPolkadot, governanceConfig))
