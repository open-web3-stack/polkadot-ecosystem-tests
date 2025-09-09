import { peoplePolkadot } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, PeopleProxyTypes, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(
    peoplePolkadot,
    { testSuiteName: 'People Polkadot Proxy', addressEncoding: 0 },
    PeopleProxyTypes,
    false,
  ),
)
