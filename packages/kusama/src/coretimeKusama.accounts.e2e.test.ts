import { coretimeKusama, kusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Kusama Coretime Accounts',
}

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  relayChain: kusama,
})

registerTestTree(accountsE2ETests(coretimeKusama, testCfg, accountsCfg))
