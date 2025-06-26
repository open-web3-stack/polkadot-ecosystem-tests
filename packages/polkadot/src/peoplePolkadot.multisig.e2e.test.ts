import { peoplePolkadot } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(peoplePolkadot, { testSuiteName: 'PeoplePolkadot Multisig', addressEncoding: 0 })
