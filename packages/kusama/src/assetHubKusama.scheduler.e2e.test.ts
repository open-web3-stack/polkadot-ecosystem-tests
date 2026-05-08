import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Scheduler',
}

registerTestTree(baseSchedulerE2ETests(assetHubKusama, pAssetHubTestConfig))
