import { assetHubKusama } from '@e2e-test/networks/chains'

import { baseProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { AssetHubProxyTypes } from '@e2e-test/shared'

registerTestTree(
  baseProxyE2ETests(assetHubKusama, { testSuiteName: 'Kusama AssetHub Proxy', addressEncoding: 2 }, AssetHubProxyTypes),
)
