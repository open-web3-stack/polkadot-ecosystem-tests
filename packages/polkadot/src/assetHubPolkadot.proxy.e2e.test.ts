import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { AssetHubProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(assetHubPolkadot, { testSuiteName: 'Polkadot AssetHub Proxy', addressEncoding: 0 }, AssetHubProxyTypes)
