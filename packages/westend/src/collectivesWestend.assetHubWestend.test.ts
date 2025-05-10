import { assetHubWestend, collectivesWestend } from '@e2e-test/networks/chains'

import { collectivesChainE2ETests } from '@e2e-test/shared'

collectivesChainE2ETests(assetHubWestend, collectivesWestend, {
  testSuiteName: 'collectives westend & asset hub westend',
})
