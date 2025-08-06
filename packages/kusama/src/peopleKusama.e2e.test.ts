import { kusama, peopleKusama } from '@e2e-test/networks/chains'

import { basePeopleChainE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(basePeopleChainE2ETests(kusama, peopleKusama, { testSuiteName: 'Kusama People', addressEncoding: 2 }))
