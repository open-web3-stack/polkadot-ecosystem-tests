import { Chain } from './types.js'
import { setupContext } from '@acala-network/chopsticks-testing'

export async function createNetwork<extended extends Record<string, unknown> | undefined>(
  chainConfig: Chain<Record<string, unknown>, Record<string, Record<string, any>>, extended>,
) {
  const network = await setupContext(chainConfig)

  console.log('createNetwork', chainConfig.name)
  if (chainConfig.initStorages) {
    await network.dev.setStorage(chainConfig.initStorages)
  }

  return {
    ...network,
    config: chainConfig,
  }
}

export type Client = Awaited<ReturnType<typeof createNetwork>>
