import { paseo } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(paseo, { testSuiteName: 'Paseo Multisig', addressEncoding: 0 })
