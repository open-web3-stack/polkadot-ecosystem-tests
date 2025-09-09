import { kusama } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, KusamaProxyTypes, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
}

registerTestTree(fullProxyE2ETests(kusama, testConfig, KusamaProxyTypes))
