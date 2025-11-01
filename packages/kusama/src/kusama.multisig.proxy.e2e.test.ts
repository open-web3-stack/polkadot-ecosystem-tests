import { kusama } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, KusamaProxyTypes, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseMultisigProxyE2Etests(
    kusama,
    { testSuiteName: 'Kusama Multisig with Proxy', addressEncoding: 2 },
    KusamaProxyTypes,
  ),
)
