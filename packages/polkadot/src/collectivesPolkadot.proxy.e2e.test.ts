import { collectivesPolkadot } from '@e2e-test/networks/chains'

import { baseProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { CollectivesProxyTypes } from '@e2e-test/shared'

registerTestTree(
  baseProxyE2ETests(
    collectivesPolkadot,
    { testSuiteName: 'Polkadot Collectives Proxy', addressEncoding: 0 },
    CollectivesProxyTypes,
  ),
)
