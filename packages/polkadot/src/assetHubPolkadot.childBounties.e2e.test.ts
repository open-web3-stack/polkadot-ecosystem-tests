import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Child Bounties',
}

registerTestTree(baseChildBountiesE2ETests(assetHubPolkadot, testConfig))
