import { polkadot } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Scheduler',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(baseSchedulerE2ETests(polkadot, testConfig))
