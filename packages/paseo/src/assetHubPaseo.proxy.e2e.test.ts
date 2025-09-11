import { assetHubPaseo } from '@e2e-test/networks/chains'
import { AssetHubPaseoProxyTypes, fullProxyE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Paseo Asset Hub Proxy',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullProxyE2ETests(assetHubPaseo, pAssetHubTestConfig, AssetHubPaseoProxyTypes))
