import { assetHubPolkadot } from '@e2e-test/networks/chains'
import {
  AssetHubPolkadotProxyTypes,
  baseMultisigProxyE2Etests,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot AssetHub Multisig Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(assetHubPolkadot, testConfig, AssetHubPolkadotProxyTypes))
