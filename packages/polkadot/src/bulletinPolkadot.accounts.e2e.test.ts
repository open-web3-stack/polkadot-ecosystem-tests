import { bulletinPolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Polkadot Bulletin Accounts',
}

const accountsCfg = createAccountsConfig({
  expectation: 'success',
})

registerTestTree(accountsE2ETests(bulletinPolkadot, testCfg, accountsCfg, polkadot))
