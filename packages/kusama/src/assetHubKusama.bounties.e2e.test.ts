import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseBountiesE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Bounties',
}

registerTestTree(baseBountiesE2ETests(assetHubKusama, testConfig))
