import { polkadot } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  manualLockAction,
  manualReserveAction,
  multisigCreationDepositAction,
  proxyAdditionDepositAction,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const generalTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Accounts',
}

// Staking and nomination pools are disabled on Polkadot relay, so the only reserve action available is manual.
const reserveActions = [manualReserveAction()]

// Vesting is disabled on Polkadot relay, so the only lock action available is the manual lock.
const lockActions = [manualLockAction()]

// Referenda submission is no longer available on Polkadot relay.
const depositActions = [proxyAdditionDepositAction(), multisigCreationDepositAction()]

const accountsTestCfg = createAccountsConfig({
  expectation: 'success',
  actions: {
    reserveActions,
    lockActions,
    depositActions,
  },
})

registerTestTree(accountsE2ETests(polkadot, generalTestConfig, accountsTestCfg))
