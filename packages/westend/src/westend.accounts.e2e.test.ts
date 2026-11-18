import { westend } from '@e2e-test/networks/chains'
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
  testSuiteName: 'Westend Accounts',
}

// As on the other post-AHM relays: staking, nomination pools, vesting and referenda all live on
// Asset Hub, so the relay offers only manual reserves and locks, and deposits from proxies and
// multisigs.
const accountsTestCfg = createAccountsConfig({
  expectation: 'success',
  actions: {
    reserveActions: [manualReserveAction()],
    lockActions: [manualLockAction()],
    depositActions: [proxyAdditionDepositAction(), multisigCreationDepositAction()],
  },
})

registerTestTree(accountsE2ETests(westend, generalTestConfig, accountsTestCfg))
