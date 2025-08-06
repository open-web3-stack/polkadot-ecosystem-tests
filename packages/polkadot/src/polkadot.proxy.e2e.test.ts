import { polkadot } from '@e2e-test/networks/chains'

import { fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { PolkadotProxyTypes } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(polkadot, { testSuiteName: 'Polkadot Proxy', addressEncoding: 0 }, PolkadotProxyTypes),
)
