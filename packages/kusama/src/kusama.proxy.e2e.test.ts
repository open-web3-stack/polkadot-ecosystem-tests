import { kusama } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, KusamaProxyTypes, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Proxy',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(fullProxyE2ETests(kusama, testConfig, KusamaProxyTypes))
