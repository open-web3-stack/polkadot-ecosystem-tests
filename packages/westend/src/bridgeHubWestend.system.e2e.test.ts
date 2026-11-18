import { assetHubWestend, bridgeHubWestend } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Westend BridgeHub System',
}

// Chopsticks' relay-to-para wiring (`connectVertical`) still reads `Dmp.downwardMessageQueues`,
// which Westend retired for paged DMP storage, so suites that pair the relay with a parachain
// cannot run yet. Restore them when chopsticks supports paged DMP.
// registerTestTree(systemE2ETestsViaRemoteScheduler(westend, bridgeHubWestend, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubWestend, bridgeHubWestend, testConfig))
