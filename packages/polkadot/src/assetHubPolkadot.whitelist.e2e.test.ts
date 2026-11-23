import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, type TestConfig, whitelistE2ETests } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Whitelist',
}

registerTestTree(whitelistE2ETests(assetHubPolkadot, testConfig))
