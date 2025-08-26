import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { AssetHubProxyTypes, fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(
    assetHubPolkadot,
    { testSuiteName: 'Polkadot Asset Hub Proxy', addressEncoding: 0 },
    AssetHubProxyTypes,
  ),
)
