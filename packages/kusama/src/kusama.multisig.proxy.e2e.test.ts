import { kusama } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, KusamaProxyTypes, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Multisig with Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(kusama, testConfig, KusamaProxyTypes))
