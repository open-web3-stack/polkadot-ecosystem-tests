import { assetHubKusama } from '@e2e-test/networks/chains'
import {
  AssetHubKusamaProxyTypes,
  baseMultisigProxyE2Etests,
  type ParaTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama AssetHub Multisig Proxy',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigProxyE2Etests(assetHubKusama, testConfig, AssetHubKusamaProxyTypes))
