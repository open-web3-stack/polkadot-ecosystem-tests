import { peoplePolkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, type ParaTestConfig, PeopleProxyTypes, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'People Polkadot Multisig Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

registerTestTree(baseMultisigProxyE2Etests(peoplePolkadot, testConfig, PeopleProxyTypes))
