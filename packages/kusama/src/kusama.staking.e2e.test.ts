import { kusama } from '@e2e-test/networks/chains'
import { completeStakingE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Staking',
  addressEncoding: 2,
  blockProvider: 'Local',
}

registerTestTree(completeStakingE2ETests(kusama, testConfig))
