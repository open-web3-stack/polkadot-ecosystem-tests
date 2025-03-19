import { peoplePolkadot } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { PeopleProxyTypes } from '@e2e-test/shared/helpers'

proxyE2ETests(peoplePolkadot, { testSuiteName: 'People Polkadot Proxy', addressEncoding: 0 }, PeopleProxyTypes)
