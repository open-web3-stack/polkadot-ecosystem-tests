import { coretimePolkadot } from '@e2e-test/networks/chains'
import {
  CoretimeProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ProxyTestConfig,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Coretime Proxy',
}

const coretimePolkadotProxyCfg: ProxyTestConfig = createProxyConfig(CoretimeProxyTypes)

registerTestTree(fullProxyE2ETests(coretimePolkadot, testConfig, coretimePolkadotProxyCfg))
