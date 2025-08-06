import { polkadot } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(polkadot, { testSuiteName: 'Polkadot Multisig', addressEncoding: 0 })
