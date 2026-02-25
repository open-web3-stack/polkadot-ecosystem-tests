import { karura } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  createDefaultDepositActions,
  manualLockAction,
  manualReserveAction,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Karura Accounts',
}

const accountsCfg = createAccountsConfig({
  expectation: 'failure',
  actions: {
    reserveActions: [manualReserveAction()],
    lockActions: [manualLockAction()],
    depositActions: createDefaultDepositActions(),
  },
})

registerTestTree(accountsE2ETests(karura, testConfig, accountsCfg))
