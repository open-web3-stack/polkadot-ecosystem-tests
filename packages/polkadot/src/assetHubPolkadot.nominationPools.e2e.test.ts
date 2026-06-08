import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseNominationPoolsE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const assetHubPolkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Nomination Pools',
}

registerTestTree(baseNominationPoolsE2ETests(assetHubPolkadot, assetHubPolkadotTestConfig))
