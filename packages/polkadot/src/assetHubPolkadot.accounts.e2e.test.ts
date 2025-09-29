import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Accounts',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  chainEd: 'Normal',
}

const accountsCfg = createAccountsConfig({
  relayChain: polkadot,
})

registerTestTree(accountsE2ETests(assetHubPolkadot, testCfg, accountsCfg))
