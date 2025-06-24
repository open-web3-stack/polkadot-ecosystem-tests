import { bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(bridgeHubPolkadot, { testSuiteName: 'BridgeHubPolkadot Multisig', addressEncoding: 0 })
