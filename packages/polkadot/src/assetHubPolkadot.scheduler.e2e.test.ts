import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const assetHubPolkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Scheduler',
}

registerTestTree(baseSchedulerE2ETests(assetHubPolkadot, assetHubPolkadotTestConfig))
