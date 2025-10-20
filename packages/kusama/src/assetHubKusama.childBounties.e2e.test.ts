import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Asset Hub Bounties',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseChildBountiesE2ETests(assetHubKusama, testConfig))
