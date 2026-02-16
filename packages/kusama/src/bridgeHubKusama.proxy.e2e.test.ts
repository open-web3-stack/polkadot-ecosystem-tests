import { bridgeHubKusama } from '@e2e-test/networks/chains'
import {
  BridgeHubProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Bridge Hub Kusama Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

const bridgeHubKusamaProxyCfg: ProxyTestConfig = createProxyConfig(BridgeHubProxyTypes)

registerTestTree(fullProxyE2ETests(bridgeHubKusama, testConfig, bridgeHubKusamaProxyCfg))
