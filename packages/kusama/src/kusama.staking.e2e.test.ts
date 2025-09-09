import { kusama } from '@e2e-test/networks/chains'
import { fullStakingTests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Staking',
  addressEncoding: 2,
  blockProvider: 'Local',
}

registerTestTree(fullStakingTests(kusama, testConfig))
