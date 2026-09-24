import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, type TestConfig, whitelistDeferredE2ETests } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Whitelist Deferred Dispatch',
}

registerTestTree(whitelistDeferredE2ETests(assetHubPolkadot, testConfig))
