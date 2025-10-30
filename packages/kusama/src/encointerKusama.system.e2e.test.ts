import { assetHubKusama, encointerKusama } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsViaRemoteScheduler } from '@e2e-test/shared'

// TODO: Uncomment after Kusama 2.0+ release due to polkadot-fellows/runtimes#957
// const testConfig: ParaTestConfig = {
//   testSuiteName: 'Kusama Encointer System',
//   addressEncoding: 0,
//   blockProvider: 'Local',
//   asyncBacking: 'Enabled',
// }

// registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, encointerKusama, testConfig))

const testConfigForAssetHub: ParaTestConfig = {
  testSuiteName: 'Kusama Encointer System',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, encointerKusama, testConfigForAssetHub))
