import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseMultisigE2Etests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Paseo Asset Hub Multisig',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigE2Etests(assetHubPolkadot, pAssetHubTestConfig))
