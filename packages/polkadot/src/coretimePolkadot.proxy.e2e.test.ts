import { coretimePolkadot } from '@e2e-test/networks/chains'
import { CoretimeProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(coretimePolkadot, { testSuiteName: 'Polkadot Coretime Proxy', addressEncoding: 0 }, CoretimeProxyTypes)
