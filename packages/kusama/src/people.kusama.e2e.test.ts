import { kusama, peopleKusama } from '@e2e-test/networks/chains'

import { PeopleChain, peopleChainE2ETests } from '@e2e-test/shared'

peopleChainE2ETests(PeopleChain.Kusama, kusama, peopleKusama)
