import { polkadot } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Accounts',
  addressEncoding: 0,
  chainEd: 'Normal',
  blockProvider: 'Local',
}

registerTestTree(transferFunctionsTests(polkadot, testConfig))
