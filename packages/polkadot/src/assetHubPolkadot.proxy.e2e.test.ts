import { assetHubPolkadot } from '@e2e-test/networks/chains'

import { fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { AssetHubProxyTypes } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(
    assetHubPolkadot,
    { testSuiteName: 'Polkadot AssetHub Proxy', addressEncoding: 0 },
    AssetHubProxyTypes,
  ),
)
