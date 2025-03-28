import { assetHubKusama } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { AssetHubProxyTypes } from '@e2e-test/shared'

proxyE2ETests(assetHubKusama, { testSuiteName: 'Kusama AssetHub Proxy', addressEncoding: 2 }, AssetHubProxyTypes)
