import { assetHubWestend, westend } from '@e2e-test/networks/chains'

import { AssetHubWestendProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(
  westend,
  assetHubWestend,
  { testSuiteName: 'Westend Asset Hub Proxy', addressEncoding: 42 },
  AssetHubWestendProxyTypes,
)
