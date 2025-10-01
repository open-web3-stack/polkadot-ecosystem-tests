import { acala } from '@e2e-test/networks/chains'
import { accountsE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Acala Accounts',
  addressEncoding: 10,
  chainEd: 'Normal',
  blockProvider: 'Local',
}

registerTestTree(accountsE2ETests(acala, testConfig))
