import { peoplePolkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, PeopleProxyTypes, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'People Polkadot Multisig Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(peoplePolkadot, testConfig, PeopleProxyTypes))
