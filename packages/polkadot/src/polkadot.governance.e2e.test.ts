import { polkadot } from '@e2e-test/networks/chains'

import { governanceE2ETests } from '@e2e-test/shared'

governanceE2ETests(polkadot, { testSuiteName: "Polkadot Governance", addressEncoding: 0})
