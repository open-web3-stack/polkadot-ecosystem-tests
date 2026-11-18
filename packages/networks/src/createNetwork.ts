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

/**
 * Storage override that clears the relay chain's downward message queues, in whichever
 * layout the runtime has.
 *
 * polkadot-sdk stable2609 replaced `Dmp.DownwardMessageQueues` with the paged
 * `DownwardMessageQueueMeta` and `DownwardMessageQueuePages` (polkadot-sdk#11909). The
 * fellowship runtimes adopt the paged layout in 2.6.0, so until enactment the live chains
 * carry the old item and the release candidates carry the new ones. Clearing a storage item
 * the runtime does not have fails the whole setup, so the choice must follow the metadata.
 */
export function dmpQueuesClearance(api: { query: Record<string, any> }): Record<string, any> {
  return api.query.dmp?.downwardMessageQueueMeta
    ? { $removePrefix: ['downwardMessageQueueMeta', 'downwardMessageQueuePages'] }
    : { $removePrefix: ['downwardMessageQueues'] }
}

export async function createNetwork<T extends Chain>(chainConfig: T) {
  const network = await setupContextWithBlockFallback(chainConfig)

  if (chainConfig.initStorages) {
    await network.dev.setStorage(chainConfig.initStorages)
  }

  // Pending downward messages at the fork point can impact test results, so relay chains
  // start with cleared queues. This cannot sit in the static chain definitions: the layout
  // depends on the runtime the fork finds, see `dmpQueuesClearance`.
  if (chainConfig.isRelayChain) {
    await network.dev.setStorage({ Dmp: dmpQueuesClearance((network as any).api) })
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
