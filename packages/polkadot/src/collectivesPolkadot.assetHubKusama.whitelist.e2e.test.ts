import {
  assetHubKusama,
  assetHubPolkadot,
  bridgeHubKusama,
  bridgeHubPolkadot,
  collectivesPolkadot,
} from '@e2e-test/networks/chains'
import { fellowshipWhitelistsCallOverBridge, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Fellowship whitelists a call on Kusama Asset Hub over the bridge',
}

registerTestTree(
  fellowshipWhitelistsCallOverBridge(
    collectivesPolkadot,
    assetHubPolkadot,
    bridgeHubPolkadot,
    bridgeHubKusama,
    assetHubKusama,
    testConfig,
  ),
)
