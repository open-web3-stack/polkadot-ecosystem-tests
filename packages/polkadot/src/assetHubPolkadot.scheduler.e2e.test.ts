import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const assetHubPolkadotTestConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Scheduler',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseSchedulerE2ETests(assetHubPolkadot, assetHubPolkadotTestConfig))
