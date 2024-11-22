import { polkadot } from '@e2e-test/networks/chains'

import { Network, governanceE2ETests } from '@e2e-test/shared'

governanceE2ETests(Network.Polkadot, polkadot)
