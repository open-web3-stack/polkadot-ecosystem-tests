import { polkadot } from '@e2e-test/networks/chains'

import { fullStakingTests, registerTestTree } from '@e2e-test/shared'

registerTestTree(fullStakingTests(polkadot, { testSuiteName: 'Polkadot Staking', addressEncoding: 0 }))
