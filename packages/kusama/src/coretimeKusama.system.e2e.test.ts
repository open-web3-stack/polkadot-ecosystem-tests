import { coretimeKusama, kusama } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, systemE2ETestsViaRelay } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Coretime System',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(systemE2ETestsViaRelay(kusama, coretimeKusama, testConfig))
