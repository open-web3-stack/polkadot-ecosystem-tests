import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { CollectivesProxyTypes, fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(
    collectivesPolkadot,
    { testSuiteName: 'Polkadot Collectives Proxy', addressEncoding: 0 },
    CollectivesProxyTypes,
  ),
)
