import { kusama } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, relayNominationPoolsE2ETests } from '@e2e-test/shared'

const kusamaTestConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Nomination Pools',
  addressEncoding: 2,
  blockProvider: 'Local',
}

registerTestTree(relayNominationPoolsE2ETests(kusama, kusamaTestConfig))
