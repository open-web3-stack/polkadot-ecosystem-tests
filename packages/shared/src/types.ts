import type { Blockchain, StorageValues } from '@acala-network/chopsticks'

import type { Chain } from '@e2e-test/networks'

import type { ApiPromise, WsProvider } from '@polkadot/api'

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
