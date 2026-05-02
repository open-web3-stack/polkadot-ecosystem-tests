import { assetHubWestend } from '@e2e-test/networks/chains'
import { baseRecoveryE2Etests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseRecoveryE2Etests(assetHubWestend, {
    testSuiteName: 'Westend Asset Hub Recovery',
  }),
)
