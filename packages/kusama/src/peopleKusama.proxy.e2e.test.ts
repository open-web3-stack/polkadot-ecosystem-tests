import { peopleKusama } from '@e2e-test/networks/chains'
import {
  createProxyConfig,
  fullProxyE2ETests,
  PeopleProxyTypes,
  type ProxyTestConfig,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'People Kusama Proxy',
}

const peopleKusamaProxyCfg: ProxyTestConfig = createProxyConfig(PeopleProxyTypes)

registerTestTree(fullProxyE2ETests(peopleKusama, testConfig, peopleKusamaProxyCfg))
