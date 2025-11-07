import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, createAccountsConfig, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Polkadot People Chain Accounts',
  addressEncoding: 0,
  blockProvider: 'Local',
  chainEd: 'Normal',
}

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  relayChain: polkadot,
})

registerTestTree(accountsE2ETests(peoplePolkadot, testCfg, accountsCfg))
