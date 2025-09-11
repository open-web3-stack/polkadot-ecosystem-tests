import { assetHubPaseo } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseGovernanceE2ETests(assetHubPaseo, {
    testSuiteName: 'Paseo Asset Hub Governance',
    addressEncoding: 0,
    blockProvider: 'NonLocal',
    asyncBacking: 'Enabled',
  }),
)
