import { polkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, PolkadotProxyTypes, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseMultisigProxyE2Etests(
    polkadot,
    { testSuiteName: 'Polkadot Multisig with Proxy', addressEncoding: 0 },
    PolkadotProxyTypes,
  ),
)
