import { coretimePolkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, CoretimeProxyTypes, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Coretime Multisig Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigProxyE2Etests(coretimePolkadot, testConfig, CoretimeProxyTypes))
