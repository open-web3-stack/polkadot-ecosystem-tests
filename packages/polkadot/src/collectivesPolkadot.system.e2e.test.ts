import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import {
  registerTestTree,
  systemE2ETestsForParaWithScheduler,
  systemE2ETestsViaRemoteScheduler,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Collectives System',
}

registerTestTree(systemE2ETestsForParaWithScheduler(collectivesPolkadot, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, collectivesPolkadot, testConfig))
