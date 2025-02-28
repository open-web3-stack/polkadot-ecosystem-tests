import { polkadot, collectivesPolkadot } from '@e2e-test/networks/chains'

import { collectivesChainE2ETests } from '@e2e-test/shared'

collectivesChainE2ETests(polkadot, collectivesPolkadot, { testSuiteName: 'Polkadot Collectives'})
