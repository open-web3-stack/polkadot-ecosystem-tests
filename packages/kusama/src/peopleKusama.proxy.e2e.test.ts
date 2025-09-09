import { peopleKusama } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, PeopleProxyTypes, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(
    peopleKusama,
    { testSuiteName: 'People Kusama Proxy', addressEncoding: 2 },
    PeopleProxyTypes,
    false,
  ),
)
