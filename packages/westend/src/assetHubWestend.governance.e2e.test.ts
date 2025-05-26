import { assetHubWestend } from '@e2e-test/networks/chains'

import { governanceE2ETests } from '@e2e-test/shared'

governanceE2ETests(assetHubWestend, { testSuiteName: 'Westend Asset Hub Governance', addressEncoding: 42 })
