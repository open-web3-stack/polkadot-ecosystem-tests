import { collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import {
  type ParaTestConfig,
  registerTestTree,
  systemE2ETestsForParaWithScheduler,
  systemE2ETestsViaRemoteScheduler,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Collectives System',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(polkadot, collectivesPolkadot, testConfig))
registerTestTree(systemE2ETestsForParaWithScheduler(collectivesPolkadot, testConfig))

// TODO: Uncomment Post-AHM on Polkadot

// const testConfigForAssetHub: ParaTestConfig = {
//   testSuiteName: 'Polkadot Collectives System',
//   addressEncoding: 0,
//   blockProvider: 'NonLocal',
//   asyncBacking: 'Enabled',
// }

// registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, collectivesPolkadot, testConfigForAssetHub))
