import { coretimePolkadot } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(coretimePolkadot, { testSuiteName: 'CoretimePolkadot Multisig', addressEncoding: 0 })
