import type { SetupOption } from '@acala-network/chopsticks-testing'

interface ChainConfigRelaychain {
  isRelayChain: true
  paraId?: undefined
}

interface ChainConfigParachain {
  isRelayChain?: false
  paraId: number
}

type ChainConfigBase = {
  name: string
  endpoint: string | string[]
  isRelayChain?: boolean
} & (ChainConfigRelaychain | ChainConfigParachain)

export type ChainConfig<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
> = ChainConfigBase &
  SetupOption & {
    custom: TCustom
    initStorages?: TInitStorages
  }

export type Chain<
  TCustom extends Record<string, unknown> | undefined = Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined =
    | Record<string, Record<string, any>>
    | undefined,
  TExtended extends Record<string, unknown> | undefined = Record<string, unknown> | undefined,
> = ChainConfig<TCustom, TInitStorages> &
  TExtended & {
    extend: <config extends Record<string, unknown>>(
      fn: (chain: Chain<TCustom, TInitStorages, TExtended>) => config,
    ) => Chain<TCustom, TInitStorages, TExtended & config>
  }
