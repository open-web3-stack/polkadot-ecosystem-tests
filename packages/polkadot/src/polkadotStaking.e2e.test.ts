import { polkadot } from '@e2e-test/networks/chains'

import { stakingE2ETests } from '@e2e-test/shared'

stakingE2ETests(polkadot, { testSuiteName: 'Polkadot Staking', addressEncoding: 0 })
