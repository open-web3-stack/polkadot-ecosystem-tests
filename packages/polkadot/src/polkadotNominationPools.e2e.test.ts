import { polkadot } from '@e2e-test/networks/chains'

import { nominationPoolsE2ETests } from '@e2e-test/shared'

nominationPoolsE2ETests(polkadot, { testSuiteName: "Polkadot Nomination Pools", addressEncoding: 0})
