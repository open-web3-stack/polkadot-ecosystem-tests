import { assetHubKusama } from '@e2e-test/networks/chains'
import { AssetHubKusamaProxyTypes, fullProxyE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama AssetHub Proxy',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullProxyE2ETests(assetHubKusama, testConfig, AssetHubKusamaProxyTypes))
