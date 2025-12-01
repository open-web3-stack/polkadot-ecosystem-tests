import { assetHubKusama } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  createDefaultDepositActions,
  createDefaultReserveActions,
  manualLockAction,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Accounts',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  chainEd: 'LowEd',
}

// When testing liquidity restrictions on Asset Hubs, to simulate frozen funds, vesting is skipped due to AHM.
const lockActions = [manualLockAction()]

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  actions: {
    reserveActions: createDefaultReserveActions(),
    lockActions,
    depositActions: createDefaultDepositActions(),
  },
})

registerTestTree(accountsE2ETests(assetHubKusama, testCfg, accountsCfg))
