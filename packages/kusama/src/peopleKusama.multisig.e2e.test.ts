import { peopleKusama } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(peopleKusama, { testSuiteName: 'PeopleKusama Multisig', addressEncoding: 2 })
