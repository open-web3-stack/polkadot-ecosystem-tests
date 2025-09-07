import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Collectives Polkadot Scheduler E2E tests',
  addressEncoding: 0,
  relayOrPara: 'Relay',
}

registerTestTree(baseSchedulerE2ETests(collectivesPolkadot, testConfig))
