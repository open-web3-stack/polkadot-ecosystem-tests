import { kusama } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, relayVestingE2ETests } from '@e2e-test/shared'

const kusamaTestConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Vesting',
  addressEncoding: 2,
  blockProvider: 'Local',
}

registerTestTree(relayVestingE2ETests(kusama, kusamaTestConfig))
