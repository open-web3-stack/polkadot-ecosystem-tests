import { Chain } from './types.js'
import { setupContext } from '@acala-network/chopsticks-testing'

export async function createNetwork<
  extended extends Record<string, unknown> | undefined,
  custom extends Record<string, unknown> | undefined = Record<string, unknown> | undefined,
  initStorages extends Record<string, Record<string, any>> | undefined =
    | Record<string, Record<string, any>>
    | undefined,
>(chainConfig: Chain<custom, initStorages, extended>) {
  const network = await setupContext(chainConfig)

  if (chainConfig.initStorages) {
    await network.dev.setStorage(chainConfig.initStorages)
  }

  return {
    ...network,
    config: chainConfig,
  }
}

export type Client = Awaited<ReturnType<typeof createNetwork>>
