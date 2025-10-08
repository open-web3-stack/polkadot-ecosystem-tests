import { bridgeHubKusama, kusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Kusama Bridge Hub Accounts',
  addressEncoding: 2,
  blockProvider: 'Local',
  chainEd: 'LowEd',
}

const accountsCfg = createAccountsConfig({
  relayChain: kusama,
})

registerTestTree(accountsE2ETests(bridgeHubKusama, testCfg, accountsCfg))
