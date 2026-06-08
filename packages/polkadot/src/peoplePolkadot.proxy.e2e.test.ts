import { peoplePolkadot } from '@e2e-test/networks/chains'
import {
  createProxyConfig,
  fullProxyE2ETests,
  PeopleProxyTypes,
  type ProxyTestConfig,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'People Polkadot Proxy',
}

const peoplePolkadotProxyCfg: ProxyTestConfig = createProxyConfig(PeopleProxyTypes)

registerTestTree(fullProxyE2ETests(peoplePolkadot, testConfig, peoplePolkadotProxyCfg))
