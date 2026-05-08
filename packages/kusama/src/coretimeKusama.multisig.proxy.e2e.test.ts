import { coretimeKusama } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, CoretimeProxyTypes, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Coretime Multisig Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(coretimeKusama, testConfig, CoretimeProxyTypes))
