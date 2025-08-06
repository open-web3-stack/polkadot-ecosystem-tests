import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'

import { basePeopleChainE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  basePeopleChainE2ETests(polkadot, peoplePolkadot, { testSuiteName: 'Polkadot People', addressEncoding: 0 }),
)
