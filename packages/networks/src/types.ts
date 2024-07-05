import { SetupOption } from '@acala-network/chopsticks-testing'

type ChainConfigBase = {
  name: string
  paraId?: number
  endpoint: string | string[]
  isRelayChain?: boolean
  relayChain?: 'polkadot' | 'kusama'
  wasmOverride?: string
}

export type ChainConfig<
  custom extends Record<string, unknown> | undefined,
  initStorages extends Record<string, Record<string, any>> | undefined,
> = ChainConfigBase &
  SetupOption & {
    custom?: custom
    initStorages?: initStorages
  }

export type Chain<
  custom extends Record<string, unknown> | undefined = Record<string, unknown> | undefined,
  initStorages extends Record<string, Record<string, any>> | undefined =
    | Record<string, Record<string, any>>
    | undefined,
  extended extends Record<string, unknown> | undefined = Record<string, unknown> | undefined,
> = ChainConfig<custom, initStorages> &
  extended & {
    extend: <config extends Record<string, unknown>>(
      fn: (chain: Chain<custom, initStorages, extended>) => config,
    ) => Chain<custom, initStorages, extended & config>
  }
