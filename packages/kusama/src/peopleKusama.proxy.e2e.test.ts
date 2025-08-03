import { peopleKusama } from '@e2e-test/networks/chains'
import { PeopleProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(peopleKusama, { testSuiteName: 'People Kusama Proxy', addressEncoding: 2 }, PeopleProxyTypes)
