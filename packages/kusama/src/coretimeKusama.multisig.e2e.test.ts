import { coretimeKusama } from '@e2e-test/networks/chains'
import { baseMultisigE2Etests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseMultisigE2Etests(coretimeKusama, {
    testSuiteName: 'CoretimeKusama Multisig',
  }),
)
