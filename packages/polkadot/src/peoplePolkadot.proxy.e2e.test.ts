import { peoplePolkadot } from '@e2e-test/networks/chains'

import { baseProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { PeopleProxyTypes } from '@e2e-test/shared'

registerTestTree(
  baseProxyE2ETests(peoplePolkadot, { testSuiteName: 'People Polkadot Proxy', addressEncoding: 0 }, PeopleProxyTypes),
)
