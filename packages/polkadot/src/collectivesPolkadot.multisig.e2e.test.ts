import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(collectivesPolkadot, { testSuiteName: 'CollectivesPolkadot Multisig', addressEncoding: 0 })
