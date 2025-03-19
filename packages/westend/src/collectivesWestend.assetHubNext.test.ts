import { assetHubNext, collectivesWestend } from '@e2e-test/networks/chains'

import { collectivesChainE2ETests } from '@e2e-test/shared'

collectivesChainE2ETests(assetHubNext, collectivesWestend, { testSuiteName: 'collectives & asset hub next' })
