import { kusama } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  createDefaultDepositActions,
  createDefaultLockActions,
  createDefaultReserveActions,
  registerTestTree,
} from '@e2e-test/shared'

// Nomination pool and staking calls are now filtered on Kusama relay
const reserveActions = createDefaultReserveActions().filter((action) => action.name.includes('manual'))

// Vesting is now filtered on Kusama relay
const lockActions = createDefaultLockActions().filter((action) => action.name.includes('manual'))

// Referenda calls are now filtered on Kusama relay
const depositActions = createDefaultDepositActions().filter((action) => !action.name.includes('referendum'))

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  actions: {
    reserveActions,
    lockActions,
    depositActions,
  },
})

registerTestTree(
  accountsE2ETests(
    kusama,
    {
      testSuiteName: 'Kusama Accounts',
      addressEncoding: 2,
      blockProvider: 'Local',
      chainEd: 'LowEd',
    },
    accountsCfg,
  ),
)
