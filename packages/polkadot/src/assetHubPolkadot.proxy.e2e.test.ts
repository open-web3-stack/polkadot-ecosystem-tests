import { assetHubPolkadot } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { AssetHubProxyTypes } from '@e2e-test/shared/helpers'

proxyE2ETests(assetHubPolkadot, { testSuiteName: 'Polkadot AssetHub Proxy', addressEncoding: 0 }, AssetHubProxyTypes)
