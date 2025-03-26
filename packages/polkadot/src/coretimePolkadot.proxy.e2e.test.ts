import { coretimePolkadot } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { CoretimeProxyTypes } from '@e2e-test/shared'

proxyE2ETests(coretimePolkadot, { testSuiteName: 'Polkadot Coretime Proxy', addressEncoding: 0 }, CoretimeProxyTypes)
