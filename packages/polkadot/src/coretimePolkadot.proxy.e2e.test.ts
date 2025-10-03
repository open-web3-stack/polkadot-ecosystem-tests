import { coretimePolkadot } from '@e2e-test/networks/chains'
import {
  CoretimeProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Coretime Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

const coretimePolkadotProxyCfg: ProxyTestConfig = createProxyConfig(CoretimeProxyTypes)

registerTestTree(fullProxyE2ETests(coretimePolkadot, testConfig, coretimePolkadotProxyCfg))
