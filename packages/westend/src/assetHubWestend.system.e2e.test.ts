import { assetHubWestend } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsForParaWithScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Westend AssetHub System',
}

// AH-Westend referenda cannot run today: `placeDecisionDeposit` declares proofSize
// 12,778,893 against a `normal.maxExtrinsic` cap of 7,340,032, so the pool rejects the
// deposit with ExhaustsResources and no referendum reaches deciding. Reported upstream.
// registerTestTree(governanceChainSelfUpgradeViaRootReferendumSuite(assetHubWestend, testConfig))

// Chopsticks' relay-to-para wiring (`connectVertical`) still reads `Dmp.downwardMessageQueues`,
// which Westend retired for paged DMP storage, so suites that pair the relay with a parachain
// cannot run yet. Restore them when chopsticks supports paged DMP.
// registerTestTree(systemE2ETestsViaRemoteScheduler(westend, assetHubWestend, testConfig))

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubWestend, testConfig))
