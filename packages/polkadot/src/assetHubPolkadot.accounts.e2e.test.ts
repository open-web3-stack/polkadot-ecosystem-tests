import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  createDefaultDepositActions,
  createDefaultLockActions,
  createDefaultReserveActions,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testCfg: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Accounts',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  chainEd: 'Normal',
}

// When testing liquidity restrictions on Asset Hubs, to simulate frozen funds, vesting is skipped due to AHM.
const lockActions = createDefaultLockActions().filter((action) => action.name.includes('vest'))

const accountsCfg = createAccountsConfig({
  relayChain: polkadot,
  actions: {
    reserveActions: createDefaultReserveActions(),
    lockActions,
    depositActions: createDefaultDepositActions(),
  },
})

registerTestTree(accountsE2ETests(assetHubPolkadot, testCfg, accountsCfg))
