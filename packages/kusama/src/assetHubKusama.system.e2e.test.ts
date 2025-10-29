import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import {
  type ParaTestConfig,
  registerTestTree,
  systemE2ETestsForParaWithScheduler,
  systemE2ETestsViaRelay,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama AssetHub System',
  addressEncoding: 2,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRelay(kusama, assetHubKusama, testConfig))

const testConfigForLocalScheduler: ParaTestConfig = {
  testSuiteName: 'Kusama AssetHub System',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubKusama, testConfigForLocalScheduler))
