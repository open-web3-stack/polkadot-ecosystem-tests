import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { AssetHubProxyTypes, fullProxyE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot AssetHub Proxy',
  addressEncoding: 0,
  relayOrPara: 'Para',
  asyncBacking: 'Enabled',
}

registerTestTree(fullProxyE2ETests(assetHubPolkadot, testConfig, AssetHubProxyTypes))
