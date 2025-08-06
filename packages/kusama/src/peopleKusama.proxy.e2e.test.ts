import { peopleKusama } from '@e2e-test/networks/chains'

import { fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { PeopleProxyTypes } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(peopleKusama, { testSuiteName: 'People Kusama Proxy', addressEncoding: 2 }, PeopleProxyTypes),
)
