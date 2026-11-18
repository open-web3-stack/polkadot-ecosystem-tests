import { coretimeWestend } from '@e2e-test/networks/chains'
import { baseMultisigE2Etests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseMultisigE2Etests(coretimeWestend, {
    testSuiteName: 'CoretimeWestend Multisig',
  }),
)
