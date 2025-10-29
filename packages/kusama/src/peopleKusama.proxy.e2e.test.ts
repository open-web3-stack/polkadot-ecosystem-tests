import { peopleKusama } from '@e2e-test/networks/chains'
import {
  createProxyConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  PeopleProxyTypes,
  type ProxyTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'People Kusama Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

const peopleKusamaProxyCfg: ProxyTestConfig = createProxyConfig(PeopleProxyTypes)

registerTestTree(fullProxyE2ETests(peopleKusama, testConfig, peopleKusamaProxyCfg))
