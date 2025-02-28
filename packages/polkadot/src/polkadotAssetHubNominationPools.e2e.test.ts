import { assetHubPolkadot } from '@e2e-test/networks/chains'

import { nominationPoolsE2ETests } from '@e2e-test/shared'

nominationPoolsE2ETests(assetHubPolkadot, { testSuiteName: 'Polkadot Nomination Pools', addressEncoding: 42 })
