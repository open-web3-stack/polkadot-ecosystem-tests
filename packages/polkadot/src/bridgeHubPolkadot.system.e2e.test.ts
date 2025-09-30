import { bridgeHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, systemE2ETestsViaRelay } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Collectives System',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(systemE2ETestsViaRelay(polkadot, bridgeHubPolkadot, testConfig))
