import { bifrostPolkadot } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  createDefaultReserveActions,
  manualLockAction,
  multisigCreationDepositAction,
  proxyAdditionDepositAction,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Bifrost Polkadot Accounts',
}

const lockActions = [manualLockAction()]

const depositActions = [
  proxyAdditionDepositAction(),
  multisigCreationDepositAction(),
  {
    name: 'referendum submission',
    createTransaction: async (client) => {
      return client.api.tx.referenda.submit(
        // The origin is irrelevant - the idea is just to get a deposit from the `referenda` pallet.
        { Origins: 'LiquidStaking' } as any,
        { Inline: client.api.tx.system.remark('test referendum').method.toHex() },
        { After: 1 },
      )
    },
    calculateDeposit: async (client) => {
      return client.api.consts.referenda.submissionDeposit.toBigInt()
    },
    isAvailable: (client) => !!client.api.tx.referenda,
  },
]

const accountsCfg = createAccountsConfig({
  expectation: 'failure',
  actions: {
    reserveActions: createDefaultReserveActions(),
    lockActions,
    depositActions,
  },
})

registerTestTree(accountsE2ETests(bifrostPolkadot, testConfig, accountsCfg))
