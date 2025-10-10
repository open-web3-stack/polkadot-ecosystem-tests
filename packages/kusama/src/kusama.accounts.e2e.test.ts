import { kusama } from '@e2e-test/networks/chains'
import type { RootTestTree } from '@e2e-test/shared'
import {
  accountsE2ETests,
  createAccountsConfig,
  manualLockAction,
  manualReserveAction,
  multisigCreationDepositAction,
  proxyAdditionDepositAction,
  registerTestTree,
} from '@e2e-test/shared'

// Staking and nomination pools are disabled on Kusama relay, so the only reserve action available is manual.
const reserveActions = [manualReserveAction()]

// Vesting is disabled on Kusama relay, so the only lock action available is the manual lock.
const lockActions = [manualLockAction()]

// Referenda submission is no longer available on Kusama relay.
const depositActions = [proxyAdditionDepositAction(), multisigCreationDepositAction()]

const accountsCfg = createAccountsConfig({
  expectation: 'success',
  actions: {
    reserveActions,
    lockActions,
    depositActions,
  },
})

/**
 * Some `burn` tests are temporarily disabled on Kusama relay, see
 * https://github.com/paritytech/polkadot-sdk/issues/9986.
 *
 * TODO: reenable after fix
 */
const filterOutBurnTests = (tree: RootTestTree): RootTestTree => {
  return {
    ...tree,
    children: tree.children.map((child) => {
      if (child.kind === 'describe' && child.label === '`burn`') {
        return {
          ...child,
          children: child.children.filter(
            (test) =>
              test.label !== 'burning funds from account works' &&
              test.label !== 'burning entire balance, or more than it, fails',
          ),
        }
      }
      return child
    }),
  }
}

registerTestTree(
  filterOutBurnTests(
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
  ),
)
