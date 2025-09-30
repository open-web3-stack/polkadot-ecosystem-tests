import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, systemE2ETestsViaRelay } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot AssetHub System',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(systemE2ETestsViaRelay(polkadot, assetHubPolkadot, testConfig))
