import { Chain, ChainConfig } from './types.js'

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  return Number(value)
}

export function defineChain<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(config: ChainConfig<TCustom, TInitStorages>): Chain<TCustom, TInitStorages> {
  const upperName = config.name.toUpperCase()
  const { endpoint, ...rest } = config
  const chainConfig = {
    wasmOverride: process.env[`${upperName}_WASM`],
    endpoint: process.env[`${upperName}_ENDPOINT`] ?? endpoint,
    db: process.env.DB_PATH,
    runtimeLogLevel: process.env.RUNTIME_LOG_LEVEL ? Number(process.env.RUNTIME_LOG_LEVEL) : 0,
    blockNumber: toNumber(process.env[`${upperName}_BLOCK_NUMBER`]),
    timeout: 60_000,
    port: 0,
    allowUnresolvedImports: true,
    ...rest,
  } as ChainConfig<TCustom, TInitStorages>

  function extend<Base extends Chain<TCustom, TInitStorages, Record<string, unknown>>>(base: Base) {
    return <config extends Record<string, unknown>>(extendFn: (base: Base) => config) => {
      const extended = extendFn(base)
      const combined = { ...base, ...extended }
      return Object.assign(combined, { extend: extend(combined) })
    }
  }

  return Object.assign(chainConfig, { extend: extend(chainConfig as any) as any })
}
