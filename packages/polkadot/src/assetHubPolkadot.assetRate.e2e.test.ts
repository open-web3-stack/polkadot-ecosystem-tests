import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseAssetRateE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Asset Rate',
}

registerTestTree(baseAssetRateE2ETests(assetHubPolkadot, testConfig))
