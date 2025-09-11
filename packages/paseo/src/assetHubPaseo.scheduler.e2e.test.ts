import { assetHubPaseo } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const pAssetHubTestConfig: ParaTestConfig = {
  testSuiteName: 'Paseo Asset Hub Scheduler',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseSchedulerE2ETests(assetHubPaseo, pAssetHubTestConfig))
