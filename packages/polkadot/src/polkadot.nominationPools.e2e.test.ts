import { polkadot } from '@e2e-test/networks/chains'

import { baseNominationPoolsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseNominationPoolsE2ETests(polkadot, { testSuiteName: 'Polkadot Nomination Pools', addressEncoding: 0 }),
)
