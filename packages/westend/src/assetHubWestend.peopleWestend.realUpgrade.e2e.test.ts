import { assetHubWestend, peopleWestend } from '@e2e-test/networks/chains'
import { realUpgradeE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  realUpgradeE2ETests(assetHubWestend, peopleWestend, {
    testSuiteName: 'Westend People real upgrade',
  }),
)
