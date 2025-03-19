import { peopleKusama } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { PeopleProxyTypes } from '@e2e-test/shared/helpers'

proxyE2ETests(peopleKusama, { testSuiteName: 'People Kusama Proxy', addressEncoding: 2 }, PeopleProxyTypes)
