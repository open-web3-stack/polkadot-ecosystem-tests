import { assetHubWestend } from '@e2e-test/networks/chains'

import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(assetHubWestend, { testSuiteName: 'Westend Asset Hub Multisig', addressEncoding: 42 })
