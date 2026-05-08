import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseBountiesE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Bounties',
}

registerTestTree(baseBountiesE2ETests(assetHubPolkadot, testConfig))
