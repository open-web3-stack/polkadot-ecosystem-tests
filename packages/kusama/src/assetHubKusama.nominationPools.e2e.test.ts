import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseNominationPoolsE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Nomination Pools',
}

registerTestTree(baseNominationPoolsE2ETests(assetHubKusama, pAssetHubTestConfig))
