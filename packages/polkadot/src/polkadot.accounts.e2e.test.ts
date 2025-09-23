import { polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Accounts',
  addressEncoding: 0,
  chainEd: 'Normal',
  blockProvider: 'Local',
}

registerTestTree(accountsE2ETests(polkadot, testConfig))
