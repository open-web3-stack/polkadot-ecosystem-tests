import type { SetupOption } from '@acala-network/chopsticks-testing'

import type { FeeExtractor } from '@e2e-test/shared'

/**
 * Chain properties useful during tests; these are made available in the client object, which will have been built
 * from a chain object containing these properties.
 */
export interface ChainProperties {
  /**
   * The chain's address encoding; decides SS58 encoding that addresses from that chain follow.
   * Useful when comparing addresses in tests.
   */
  addressEncoding: number
  /**
   * Whether the chain uses its own `Local` block numbers to e.g. index its scheduler's agenda, or another block
   * provider e.g. `NonLocal` means the relay's block number is used.
   */
  blockProvider: 'Local' | 'NonLocal'
  /**
   * Whether the chain's ED is low relative to the average transaction fee, or of a similar order of magnitude.
   */
  chainEd: 'LowEd' | 'Normal'
  /**
   * How to query and process a transaction fee payment event from this particular chain (see {@link FeeExtractor}).
   */
  feeExtractor?: FeeExtractor
}

interface ChainConfigRelaychain {
  isRelayChain: true
  paraId?: undefined
  properties: ChainProperties
}

interface ChainConfigParachain {
  isRelayChain?: false
  paraId: number
  properties: ChainProperties & { asyncBacking: 'Enabled' | 'Disabled' }
}

type ChainConfigBase = {
  name: string
  endpoint: string | string[]
  isRelayChain?: boolean
  networkGroup: 'polkadot' | 'kusama'
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
