import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const pAssetHubTestConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Asset Hub Scheduler',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseSchedulerE2ETests(assetHubKusama, pAssetHubTestConfig))
