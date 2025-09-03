import { kusama } from '@e2e-test/networks/chains'
import type { TestConfig } from '@e2e-test/shared'
import { baseGovernanceE2ETests, registerTestTree } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Governance',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(baseGovernanceE2ETests(kusama, testConfig))
