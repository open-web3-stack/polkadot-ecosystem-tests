import { kusama } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, KusamaProxyTypes, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Multisig with Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigProxyE2Etests(kusama, testConfig, KusamaProxyTypes))
