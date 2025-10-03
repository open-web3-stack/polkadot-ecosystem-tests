import { coretimeKusama } from '@e2e-test/networks/chains'
import {
  CoretimeProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Coretime Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

const coretimeKusamaProxyCfg: ProxyTestConfig = createProxyConfig(CoretimeProxyTypes)

registerTestTree(fullProxyE2ETests(coretimeKusama, testConfig, coretimeKusamaProxyCfg))
