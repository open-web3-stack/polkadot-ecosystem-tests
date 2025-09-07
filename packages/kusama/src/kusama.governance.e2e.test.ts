import { kusama } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Governance',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(baseGovernanceE2ETests(kusama, testConfig))
