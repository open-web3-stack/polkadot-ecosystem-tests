import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { baseTreasuryE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Treasury',
}

registerTestTree(baseTreasuryE2ETests(polkadot, assetHubPolkadot, testConfig))
