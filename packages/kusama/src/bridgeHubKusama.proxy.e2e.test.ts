import { bridgeHubKusama } from '@e2e-test/networks/chains'
import {
  BridgeHubProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ProxyTestConfig,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Bridge Hub Kusama Proxy',
}

const bridgeHubKusamaProxyCfg: ProxyTestConfig = createProxyConfig(BridgeHubProxyTypes)

registerTestTree(fullProxyE2ETests(bridgeHubKusama, testConfig, bridgeHubKusamaProxyCfg))
