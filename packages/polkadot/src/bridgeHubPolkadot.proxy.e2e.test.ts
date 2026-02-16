import { bridgeHubPolkadot } from '@e2e-test/networks/chains'
import {
  BridgeHubProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Bridge Hub Polkadot Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

const bridgeHubPolkadotProxyCfg: ProxyTestConfig = createProxyConfig(BridgeHubProxyTypes)

registerTestTree(fullProxyE2ETests(bridgeHubPolkadot, testConfig, bridgeHubPolkadotProxyCfg))
