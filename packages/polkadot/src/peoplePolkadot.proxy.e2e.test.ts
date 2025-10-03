import { peoplePolkadot } from '@e2e-test/networks/chains'
import {
  createProxyConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  PeopleProxyTypes,
  type ProxyTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'People Polkadot Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

const peoplePolkadotProxyCfg: ProxyTestConfig = createProxyConfig(PeopleProxyTypes)

registerTestTree(fullProxyE2ETests(peoplePolkadot, testConfig, peoplePolkadotProxyCfg))
