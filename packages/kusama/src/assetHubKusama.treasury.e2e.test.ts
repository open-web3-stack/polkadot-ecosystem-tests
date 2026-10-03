import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import { baseTreasuryE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Treasury',
}

registerTestTree(baseTreasuryE2ETests(kusama, assetHubKusama, testConfig))
