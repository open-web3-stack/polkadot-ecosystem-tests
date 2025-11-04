import { polkadot } from '@e2e-test/networks/chains'
import { basePreimageE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot PreImage',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(basePreimageE2ETests(polkadot, testConfig))
