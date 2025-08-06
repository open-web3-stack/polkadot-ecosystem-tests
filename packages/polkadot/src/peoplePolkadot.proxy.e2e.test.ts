import { peoplePolkadot } from '@e2e-test/networks/chains'
import { PeopleProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(peoplePolkadot, { testSuiteName: 'People Polkadot Proxy', addressEncoding: 0 }, PeopleProxyTypes)
