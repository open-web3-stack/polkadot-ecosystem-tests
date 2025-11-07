import { polkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, type ParaTestConfig, PolkadotProxyTypes, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Multisig with Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigProxyE2Etests(polkadot, testConfig, PolkadotProxyTypes))
