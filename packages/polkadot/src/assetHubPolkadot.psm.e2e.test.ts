import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { psmE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub PSM',
}

registerTestTree(psmE2ETests(assetHubPolkadot, testCfg))
