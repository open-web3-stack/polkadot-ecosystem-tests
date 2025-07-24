import { bridgeHubPolkadot } from '@e2e-test/networks/chains'

import { baseMultisigE2Etests } from '@e2e-test/shared'
import { registerTestTree } from '@e2e-test/shared/types'

registerTestTree(
  baseMultisigE2Etests(bridgeHubPolkadot, { testSuiteName: 'BridgeHubPolkadot Multisig', addressEncoding: 0 }),
)
