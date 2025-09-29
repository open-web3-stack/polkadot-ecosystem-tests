import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Accounts',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  chainEd: 'LowEd',
}

const accountsCfg = createAccountsConfig({
  relayChain: kusama,
})

registerTestTree(accountsE2ETests(assetHubKusama, testCfg, accountsCfg))
