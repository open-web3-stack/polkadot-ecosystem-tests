import { assetHubPaseo } from '@e2e-test/networks/chains'
import { AssetHubPaseoProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(assetHubPaseo, { testSuiteName: 'Paseo Asset Hub Proxy', addressEncoding: 0 }, AssetHubPaseoProxyTypes)
