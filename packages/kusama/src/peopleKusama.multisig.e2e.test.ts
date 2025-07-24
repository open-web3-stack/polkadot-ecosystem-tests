import { peopleKusama } from '@e2e-test/networks/chains'

import { baseMultisigE2Etests } from '@e2e-test/shared'
import { registerTestTree } from '@e2e-test/shared/types'

registerTestTree(baseMultisigE2Etests(peopleKusama, { testSuiteName: 'PeopleKusama Multisig', addressEncoding: 2 }))
