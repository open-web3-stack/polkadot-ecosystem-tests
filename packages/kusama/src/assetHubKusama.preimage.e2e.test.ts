import { assetHubKusama } from '@e2e-test/networks/chains'
import { basePreimageE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Preimage',
}

registerTestTree(basePreimageE2ETests(assetHubKusama, testConfig))
