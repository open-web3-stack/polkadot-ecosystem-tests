import { kusama, peopleKusama } from '@e2e-test/networks/chains'

import { peopleChainE2ETests } from '@e2e-test/shared'

peopleChainE2ETests('Polkadot People', kusama, peopleKusama)
