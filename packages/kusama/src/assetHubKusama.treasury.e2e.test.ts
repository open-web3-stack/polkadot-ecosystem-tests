import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import { baseTreasuryE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Asset Hub Treasury',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseTreasuryE2ETests(kusama, assetHubKusama, testConfig))
