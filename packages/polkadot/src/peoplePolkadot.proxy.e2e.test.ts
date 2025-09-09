import { peoplePolkadot } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, type ParaTestConfig, PeopleProxyTypes, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'People Polkadot Proxy',
  addressEncoding: 0,
  relayOrPara: 'Para',
  asyncBacking: 'Disabled',
}

registerTestTree(fullProxyE2ETests(peoplePolkadot, testConfig, PeopleProxyTypes))
