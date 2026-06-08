import { coretimeKusama } from '@e2e-test/networks/chains'
import {
  CoretimeProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ProxyTestConfig,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Coretime Proxy',
}

const coretimeKusamaProxyCfg: ProxyTestConfig = createProxyConfig(CoretimeProxyTypes)

registerTestTree(fullProxyE2ETests(coretimeKusama, testConfig, coretimeKusamaProxyCfg))
