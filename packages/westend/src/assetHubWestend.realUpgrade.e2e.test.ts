import { assetHubWestend } from '@e2e-test/networks/chains'
import { realUpgradeE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  realUpgradeE2ETests(assetHubWestend, assetHubWestend, {
    testSuiteName: 'Westend Asset Hub real upgrade',
  }),
)
