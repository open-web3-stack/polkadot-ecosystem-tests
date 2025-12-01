import { coretimePolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Polkadot Coretime Accounts',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
  chainEd: 'Normal',
}

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  relayChain: polkadot,
})

registerTestTree(accountsE2ETests(coretimePolkadot, testCfg, accountsCfg))
