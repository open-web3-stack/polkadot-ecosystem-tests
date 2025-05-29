import { collectivesPolkadot } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { CollectivesProxyTypes } from '@e2e-test/shared'

proxyE2ETests(
  collectivesPolkadot,
  { testSuiteName: 'Polkadot Collectives Proxy', addressEncoding: 0 },
  CollectivesProxyTypes,
)
