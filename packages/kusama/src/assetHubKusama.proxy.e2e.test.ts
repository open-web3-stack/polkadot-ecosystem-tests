import { assetHubKusama } from '@e2e-test/networks/chains'
import { AssetHubProxyTypes, fullProxyE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama AssetHub Proxy',
  addressEncoding: 2,
  relayOrPara: 'Para',
  asyncBacking: 'Enabled',
}

registerTestTree(fullProxyE2ETests(assetHubKusama, testConfig, AssetHubProxyTypes))
