import { hydration } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  createDefaultDepositActions,
  manualLockAction,
  manualReserveAction,
  type ParaTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Hydration Accounts',
  addressEncoding: 0,
  chainEd: 'Normal',
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  actions: {
    reserveActions: [manualReserveAction()],
    lockActions: [manualLockAction()],
    depositActions: createDefaultDepositActions(),
  },
})

registerTestTree(accountsE2ETests(hydration, testConfig, accountsCfg))
