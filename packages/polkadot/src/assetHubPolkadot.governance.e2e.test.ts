import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseGovernanceE2ETests(assetHubPolkadot, {
    testSuiteName: 'Polkadot Asset Hub Governance',
    addressEncoding: 0,
    blockProvider: 'NonLocal',
    asyncBacking: 'Enabled',
  }),
)
