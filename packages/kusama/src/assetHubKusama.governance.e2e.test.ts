import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseGovernanceE2ETests(assetHubKusama, {
    testSuiteName: 'Kusama Asset Hub Governance',
    addressEncoding: 2,
    blockProvider: 'NonLocal',
    asyncBacking: 'Enabled',
  }),
)
