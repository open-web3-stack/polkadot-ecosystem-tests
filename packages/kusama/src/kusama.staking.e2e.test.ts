import { kusama } from '@e2e-test/networks/chains'
import { fullStakingTests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Staking',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(fullStakingTests(kusama, testConfig))
