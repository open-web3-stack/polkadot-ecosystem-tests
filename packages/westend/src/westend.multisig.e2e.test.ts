import { westend } from '@e2e-test/networks/chains'

import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(westend, { testSuiteName: 'Westend Multisig', addressEncoding: 42 })
