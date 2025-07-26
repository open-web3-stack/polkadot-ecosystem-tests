import type { Blockchain, StorageValues } from '@acala-network/chopsticks'
import type { Chain } from '@e2e-test/networks'
import type { ApiPromise, WsProvider } from '@polkadot/api'

import { match } from 'ts-pattern'
import { afterAll, beforeAll, describe, test } from 'vitest'

export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

/**
 * Type of client object produced by `setupNetworks` in E2E test suites.
 */
export type Client<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
> = {
  config: Chain<TCustom, TInitStorages>
  url: string
  chain: Blockchain
  ws: WsProvider
  api: ApiPromise
  dev: {
    newBlock: (param?: Partial<any>) => Promise<string>
    setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    timeTravel: (date: string | number) => Promise<number>
    setHead: (hashOrNumber: string | number) => Promise<any>
  }
  teardown(): Promise<void>
  pause(): Promise<unknown>
}

export type TestNode = {
  kind: 'test'
  /**
   * The label used to identify the test node when `vitest.test` is called.
   */
  label: string
  /**
   * A function returning a promise (actual test body).
   * This is passed into `vitest.test(...)` during registration.
   */
  testFn: () => Promise<void>
  flags?: { only?: boolean; skip?: boolean; timeout?: number }
  meta?: Record<string, any>
}

export type DescribeNode = {
  kind: 'describe'
  label: string
  children: TestTree[]
  beforeAll?: () => Promise<void>
  afterAll?: () => Promise<void>
  flags?: { only?: boolean; skip?: boolean }
  meta?: Record<string, any>
}

/**
 * A test tree, used to represent an E2E test suite.
 */
export type TestTree = TestNode | DescribeNode

/**
 * Create an end-to-end test tree, to be used in an E2E test suite.
 *
 * This function recursively walks an in-memory rose tree of `describe` / `test` nodes and
 * registers them with Vitest.
 *
 * Call this exactly once per suite at module scope:
 * ```ts
 * const suite: TestTree = { … }
 * registerTestTree(suite)
 * ```
 *
 * The function is intentionally side-effectful: each invocation calls
 * `vitest.describe` / `vitest.test` immediately so that Vitest picks the tests
 * up during collection.
 */
export function registerTestTree(node: TestTree) {
  match(node)
    .with({ kind: 'test' }, (testNode) => {
      const t = testNode.flags?.only ? test.only : testNode.flags?.skip ? test.skip : test

      // Recall this is `test` from `vitest`
      t(testNode.label, { timeout: testNode.flags?.timeout }, testNode.testFn)
    })
    .with({ kind: 'describe' }, (describeNode) => {
      const d = describeNode.flags?.only ? describe.only : describeNode.flags?.skip ? describe.skip : describe

      // Recall this is `describe` from `vitest`
      d(describeNode.label, () => {
        if (describeNode.beforeAll) beforeAll(describeNode.beforeAll)
        if (describeNode.afterAll) afterAll(describeNode.afterAll)
        describeNode.children.forEach(registerTestTree)
      })
    })
    .exhaustive()
}
