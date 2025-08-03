import { kusama } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(kusama, { testSuiteName: 'Kusama Multisig', addressEncoding: 2 })
