import { coretimePolkadot } from '@e2e-test/networks/chains'
import { baseMultisigE2Etests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseMultisigE2Etests(coretimePolkadot, {
    testSuiteName: 'CoretimePolkadot Multisig',
    addressEncoding: 0,
  }),
)
