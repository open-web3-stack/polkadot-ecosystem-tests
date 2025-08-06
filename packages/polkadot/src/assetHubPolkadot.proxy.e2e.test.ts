import { assetHubPolkadot } from '@e2e-test/networks/chains'

import { baseProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { AssetHubProxyTypes } from '@e2e-test/shared'

registerTestTree(
  baseProxyE2ETests(
    assetHubPolkadot,
    { testSuiteName: 'Polkadot AssetHub Proxy', addressEncoding: 0 },
    AssetHubProxyTypes,
  ),
)
