import { kusama } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, relayStakingE2ETests } from '@e2e-test/shared'

const kusamaTestConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Staking',
  addressEncoding: 2,
  blockProvider: 'Local',
}

registerTestTree(relayStakingE2ETests(kusama, kusamaTestConfig))
