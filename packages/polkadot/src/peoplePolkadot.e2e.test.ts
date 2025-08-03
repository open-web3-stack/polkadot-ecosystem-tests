import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { peopleChainE2ETests } from '@e2e-test/shared'

peopleChainE2ETests(polkadot, peoplePolkadot, { testSuiteName: 'Polkadot People', addressEncoding: 0 })
