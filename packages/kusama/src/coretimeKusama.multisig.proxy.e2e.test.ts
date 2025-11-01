import { coretimeKusama } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, CoretimeProxyTypes, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Coretime Multisig Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigProxyE2Etests(coretimeKusama, testConfig, CoretimeProxyTypes))
