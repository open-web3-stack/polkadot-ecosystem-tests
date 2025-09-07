import { kusama } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Scheduler',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(baseSchedulerE2ETests(kusama, testConfig))
