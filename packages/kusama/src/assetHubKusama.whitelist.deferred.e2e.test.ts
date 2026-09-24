import { assetHubKusama } from '@e2e-test/networks/chains'
import { registerTestTree, type TestConfig, whitelistDeferredE2ETests } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Whitelist Deferred Dispatch',
}

registerTestTree(whitelistDeferredE2ETests(assetHubKusama, testConfig))
