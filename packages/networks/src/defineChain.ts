import { Chain, ChainConfig } from './types.js'

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  return Number(value)
}

export function defineChain<
  custom extends Record<string, unknown> | undefined,
  initStorages extends Record<string, Record<string, any>> | undefined,
>(config: ChainConfig<custom, initStorages>): Chain<custom, initStorages> {
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
  } as ChainConfig<custom, initStorages>

  function extend<Base extends Chain<custom, initStorages, Record<string, unknown>>>(base: Base) {
    return <config extends Record<string, unknown>>(extendFn: (base: Base) => config) => {
      const extended = extendFn(base)
      const combined = { ...base, ...extended }
      return Object.assign(combined, { extend: extend(combined) })
    }
  }

  return Object.assign(chainConfig, { extend: extend(chainConfig as any) as any })
}
