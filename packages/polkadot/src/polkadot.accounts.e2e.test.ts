import { polkadot } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  type DescribeNode,
  manualLockAction,
  manualReserveAction,
  multisigCreationDepositAction,
  proxyAdditionDepositAction,
  type RootTestTree,
  registerTestTree,
  type TestConfig,
  type TestNode,
} from '@e2e-test/shared'

import { match } from 'ts-pattern'

const generalTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Accounts',
}

// Staking and nomination pools are disabled on Polkadot relay, so the only reserve action available is manual.
const reserveActions = [manualReserveAction()]

// Vesting is also disabled, so the only lock action available is the manual lock.
const lockActions = [manualLockAction()]

// Referenda submission is no longer available, either.
const depositActions = [proxyAdditionDepositAction(), multisigCreationDepositAction()]

const accountsTestCfg = createAccountsConfig({
  expectation: 'success',
  actions: {
    reserveActions,
    lockActions,
    depositActions,
  },
})

// `burn` tests are disabled on Polkadot relay. See https://github.com/paritytech/polkadot-sdk/issues/9986.
//
// Root cause: post-AHM, most validator relay-chain accounts have small or zero residual
// free balances. `DealWithFees` routes 20% of every tx fee to the block author via
// `ToAuthor`; `pallet_balances::resolve` rejects deposits below ED, silently drops the
// `Credit`, and `TotalIssuance` shrinks by `0.2 × fee`. The burn tests assert strict TI
// equality, so they fail by exactly that amount.
//
// Whether this manifests depends on the specific block author's free balance vs ED:
//   - Polkadot ED = 10,000,000,000 Planck (1 DOT): most post-AHM validator balances are
//     below this, so the deposit fails consistently at the current known-good block.
//   - Kusama ED = 333,333,333 Planck (~0.033 KSM): smaller, so the author at the current
//     Kusama known-good block happens to clear it — but Kusama will fail too if its
//     known-good block is updated to one where the author's balance is below that ED.
//
// The correct fix is upstream: `DealWithFees`/`ToAuthor` must not silently drop the fee
// credit when the author account is below ED (e.g. route to treasury instead).
// TODO: remove this filter once that is resolved.
const filterOutBurnTests = (tree: RootTestTree): RootTestTree => {
  const filterChildren = (children: (TestNode | DescribeNode)[]): (TestNode | DescribeNode)[] => {
    return children
      .filter((child) => !child.label.includes('burn'))
      .map((child) => {
        return match(child)
          .with({ kind: 'test' }, () => child)
          .with({ kind: 'describe' }, (desc) => {
            return { ...desc, children: filterChildren(desc.children) }
          })
          .exhaustive()
      })
  }

  return {
    ...tree,
    children: filterChildren(tree.children),
  }
}

registerTestTree(filterOutBurnTests(accountsE2ETests(polkadot, generalTestConfig, accountsTestCfg)))
