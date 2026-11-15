import { kusama, peopleKusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Kusama People Chain Accounts',
}

const accountsCfg = createAccountsConfig({
  expectation: 'success',
})

registerTestTree(accountsE2ETests(peopleKusama, testCfg, accountsCfg, kusama))
