import { assetHubKusama } from '@e2e-test/networks/chains'
import { registerTestTree, type TestConfig, whitelistE2ETests } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Whitelist',
}

registerTestTree(whitelistE2ETests(assetHubKusama, testConfig))
