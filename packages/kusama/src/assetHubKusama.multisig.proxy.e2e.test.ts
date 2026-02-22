import { assetHubKusama } from '@e2e-test/networks/chains'
import {
  AssetHubKusamaProxyTypes,
  baseMultisigProxyE2Etests,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama AssetHub Multisig Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(assetHubKusama, testConfig, AssetHubKusamaProxyTypes))
