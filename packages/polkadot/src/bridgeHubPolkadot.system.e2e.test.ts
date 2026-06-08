import { assetHubPolkadot, bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfigForAssetHub: TestConfig = {
  testSuiteName: 'Polkadot BridgeHub System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, bridgeHubPolkadot, testConfigForAssetHub))
