import { peopleKusama } from '@e2e-test/networks/chains'

import { baseProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { PeopleProxyTypes } from '@e2e-test/shared'

registerTestTree(
  baseProxyE2ETests(peopleKusama, { testSuiteName: 'People Kusama Proxy', addressEncoding: 2 }, PeopleProxyTypes),
)
