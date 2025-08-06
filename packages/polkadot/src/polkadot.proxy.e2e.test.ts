import { polkadot } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, PolkadotProxyTypes, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(polkadot, { testSuiteName: 'Polkadot Proxy', addressEncoding: 0 }, PolkadotProxyTypes),
)
