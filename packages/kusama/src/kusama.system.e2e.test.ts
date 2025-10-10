import { kusama } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, systemE2ETests } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama System',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(systemE2ETests(kusama, testConfig))
