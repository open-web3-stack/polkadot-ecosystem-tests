import { polkadot } from '@e2e-test/networks/chains'

import { registerTestTree, relayVestingE2ETests } from '@e2e-test/shared'

registerTestTree(relayVestingE2ETests(polkadot, { testSuiteName: 'Polkadot Vesting', addressEncoding: 0 }))
