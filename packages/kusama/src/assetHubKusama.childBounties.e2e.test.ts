import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Bounties',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseChildBountiesE2ETests(assetHubKusama, testConfig))
