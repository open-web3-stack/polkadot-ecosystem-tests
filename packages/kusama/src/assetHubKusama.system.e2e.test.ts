import { assetHubKusama } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsForParaWithScheduler } from '@e2e-test/shared'
import { governanceChainSelfUpgradeViaRootReferendumSuite } from '@e2e-test/shared/upgrade'

// TODO: Uncomment after Kusama 2.0+ release due to polkadot-fellows/runtimes#957
// const testConfig: ParaTestConfig = {
//   testSuiteName: 'Kusama AssetHub System',
//   addressEncoding: 2,
//   blockProvider: 'Local',
//   asyncBacking: 'Enabled',
// }
// registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, assetHubKusama, testConfig))

const testConfigForLocalScheduler: ParaTestConfig = {
  testSuiteName: 'Kusama AssetHub System',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubKusama, testConfigForLocalScheduler))

registerTestTree(governanceChainSelfUpgradeViaRootReferendumSuite(assetHubKusama, testConfigForLocalScheduler))
