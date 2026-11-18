import { assetHubWestend, peopleWestend } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Westend People System',
}

// Chopsticks' relay-to-para wiring (`connectVertical`) still reads `Dmp.downwardMessageQueues`,
// which Westend retired for paged DMP storage, so suites that pair the relay with a parachain
// cannot run yet. Restore them when chopsticks supports paged DMP:
// https://github.com/AcalaNetwork/chopsticks/issues/1104
// registerTestTree(systemE2ETestsViaRemoteScheduler(westend, peopleWestend, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubWestend, peopleWestend, testConfig))
