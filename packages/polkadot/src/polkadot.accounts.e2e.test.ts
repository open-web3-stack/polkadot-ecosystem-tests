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
