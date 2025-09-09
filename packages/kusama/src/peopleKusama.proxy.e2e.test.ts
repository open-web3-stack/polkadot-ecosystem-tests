import { peopleKusama } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, type ParaTestConfig, PeopleProxyTypes, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'People Kusama Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

registerTestTree(fullProxyE2ETests(peopleKusama, testConfig, PeopleProxyTypes))
