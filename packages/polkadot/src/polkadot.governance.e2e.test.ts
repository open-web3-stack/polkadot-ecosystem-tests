import { polkadot } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Governance',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(baseGovernanceE2ETests(polkadot, testConfig))
