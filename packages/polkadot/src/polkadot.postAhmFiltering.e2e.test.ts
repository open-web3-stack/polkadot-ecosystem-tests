import { polkadot } from '@e2e-test/networks/chains'
import {
  postAhmFilteringE2ETests,
  type RelayTestConfig,
  registerTestTree,
  setupNetworksForRelay,
} from '@e2e-test/shared'

const polkadotTestConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Post-AHM Filtering Tests',
  addressEncoding: 0,
  blockProvider: 'Local',
  setupNetworks: setupNetworksForRelay,
}

registerTestTree(postAhmFilteringE2ETests(polkadot, polkadotTestConfig))
