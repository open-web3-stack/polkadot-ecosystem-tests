import { peopleKusama } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, type ParaTestConfig, PeopleProxyTypes, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'People Kusama Multisig Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

registerTestTree(baseMultisigProxyE2Etests(peopleKusama, testConfig, PeopleProxyTypes))
