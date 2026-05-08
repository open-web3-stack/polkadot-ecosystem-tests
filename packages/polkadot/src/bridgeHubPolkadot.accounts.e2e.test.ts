import { bridgeHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Polkadot Bridge Hub Accounts',
}

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  relayChain: polkadot,
})

registerTestTree(accountsE2ETests(bridgeHubPolkadot, testCfg, accountsCfg))
