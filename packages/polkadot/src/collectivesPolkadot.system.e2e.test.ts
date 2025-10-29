import { collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import {
  type ParaTestConfig,
  registerTestTree,
  systemE2ETestsForParaWithScheduler,
  systemE2ETestsViaRelay,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Collectives System',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRelay(polkadot, collectivesPolkadot, testConfig))

registerTestTree(systemE2ETestsForParaWithScheduler(collectivesPolkadot, testConfig))
