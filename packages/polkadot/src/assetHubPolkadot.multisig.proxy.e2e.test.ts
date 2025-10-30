import { assetHubPolkadot } from '@e2e-test/networks/chains'
import {
  AssetHubPolkadotProxyTypes,
  baseMultisigProxyE2Etests,
  type ParaTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot AssetHub Multisig Proxy',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigProxyE2Etests(assetHubPolkadot, testConfig, AssetHubPolkadotProxyTypes))
