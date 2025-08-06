import { assetHubKusama } from '@e2e-test/networks/chains'

import { fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { AssetHubProxyTypes } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(assetHubKusama, { testSuiteName: 'Kusama AssetHub Proxy', addressEncoding: 2 }, AssetHubProxyTypes),
)
