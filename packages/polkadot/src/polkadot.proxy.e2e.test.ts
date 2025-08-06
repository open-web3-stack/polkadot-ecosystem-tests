import { polkadot } from '@e2e-test/networks/chains'
import { PolkadotProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(polkadot, { testSuiteName: 'Polkadot Proxy', addressEncoding: 0 }, PolkadotProxyTypes)
