import { connectParachains, connectVertical } from '@acala-network/chopsticks'
import { setupContext } from '@acala-network/chopsticks-testing'

import type { Chain } from './types.js'

async function setupContextWithBlockFallback<T extends Chain>(chainConfig: T) {
  let attempt = 0
  let blockNumber = chainConfig.blockNumber
  let lastError: unknown

  while (attempt < 4) {
    try {
      return await setupContext({
        ...chainConfig,
        blockNumber,
      })
    } catch (error) {
      lastError = error
      if (!(error instanceof Error) || !error.message.includes('Cannot find block hash for') || blockNumber == null) {
        throw error
      }
      attempt++
      blockNumber -= 5_000
    }
  }

  throw lastError
}

export async function createNetwork<T extends Chain>(chainConfig: T) {
  const network = await setupContextWithBlockFallback(chainConfig)

  if (chainConfig.initStorages) {
    await network.dev.setStorage(chainConfig.initStorages)
  }

  return {
    ...network,
    config: chainConfig,
  }
}

export type Client<T extends Chain = Chain> = Awaited<ReturnType<typeof createNetwork<T>>>

export async function createNetworks<T extends Chain[]>(...configs: T) {
  const networks = (await Promise.all(configs.map(createNetwork))) as { [I in keyof T]: Client<T[I]> }

  const relaychain = networks.find(({ config }) => config.isRelayChain)
  const parachains = networks.filter(({ config }) => !config.isRelayChain)

  await connectParachains(
    parachains.map(({ chain }) => chain),
    true,
  )
  if (relaychain) {
    for (const parachain of parachains) {
      await connectVertical(relaychain.chain, parachain.chain)
    }
  }

  return networks
}
