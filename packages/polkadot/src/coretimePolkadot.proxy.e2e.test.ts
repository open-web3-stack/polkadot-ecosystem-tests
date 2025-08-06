import { coretimePolkadot } from '@e2e-test/networks/chains'

import { baseProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { CoretimeProxyTypes } from '@e2e-test/shared'

registerTestTree(
  baseProxyE2ETests(
    coretimePolkadot,
    { testSuiteName: 'Polkadot Coretime Proxy', addressEncoding: 0 },
    CoretimeProxyTypes,
  ),
)
