import { coretimePolkadot } from '@e2e-test/networks/chains'
import { CoretimeProxyTypes, fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(
    coretimePolkadot,
    { testSuiteName: 'Polkadot Coretime Proxy', addressEncoding: 0 },
    CoretimeProxyTypes,
  ),
)
