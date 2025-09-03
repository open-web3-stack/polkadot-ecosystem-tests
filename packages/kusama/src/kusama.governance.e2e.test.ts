import { kusama } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, registerTestTree } from '@e2e-test/shared'
import type { TestConfig } from '@e2e-test/shared/helpers'

const testConfig = {
  testSuiteName: 'Kusama Governance',
  addressEncoding: 2,
  relayOrPara: 'Relay',
} as TestConfig<'Relay'>

registerTestTree(baseGovernanceE2ETests(kusama, testConfig))
