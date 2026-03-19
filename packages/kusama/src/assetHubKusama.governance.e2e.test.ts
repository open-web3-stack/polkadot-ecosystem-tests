import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, type GovernanceTestConfig, registerTestTree } from '@e2e-test/shared'

// Tracks selected by referendum volume (Polkassembly, all-time) + criticality.
// Only one track is active: the per-track tests are identical in logic and each takes ~15 s,
// so running every track is repetitive. Uncomment additional tracks as needed.
const governanceConfig: GovernanceTestConfig = {
  testSuiteName: 'Kusama Asset Hub Governance',
  tracks: [
    // --- high-volume tracks (by referendum count) ---
    //{ trackId: 33, trackName: 'medium_spender', originName: 'MediumSpender' }, //  123 refs (19.2 %)
    { trackId: 34, trackName: 'big_spender', originName: 'BigSpender' }, //           90 refs (14.0 %)
    //{ trackId: 32, trackName: 'small_spender', originName: 'SmallSpender' }, //      61 refs  (9.5 %)
    //{ trackId: 30, trackName: 'small_tipper', originName: 'SmallTipper' }, //        46 refs  (7.2 %)
    //{ trackId: 31, trackName: 'big_tipper', originName: 'BigTipper' }, //            19 refs  (3.0 %)
    // --- critical tracks (low volume, high impact) ---
    { trackId: 0, trackName: 'root', originName: 'Root', systemOrigin: true }, //    41 refs  (6.4 %)
    //{ trackId: 1, trackName: 'whitelisted_caller', originName: 'WhitelistedCaller' }, // 124 refs (19.3 %)
    //{ trackId: 20, trackName: 'referendum_canceller', originName: 'ReferendumCanceller' }, // 12 refs (1.9 %)
    { trackId: 21, trackName: 'referendum_killer', originName: 'ReferendumKiller' }, //        5 refs (0.8 %)
  ],
}

registerTestTree(baseGovernanceE2ETests(assetHubKusama, governanceConfig))
