import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { fullStakingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const assetHubPolkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Staking',
}

registerTestTree(fullStakingE2ETests(assetHubPolkadot, assetHubPolkadotTestConfig))
