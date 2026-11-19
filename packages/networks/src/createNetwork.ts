import { connectParachains, connectVertical } from '@acala-network/chopsticks'
import { setupContext } from '@acala-network/chopsticks-testing'

import { u8aConcat, u8aToHex } from '@polkadot/util'
import { xxhashAsU8a } from '@polkadot/util-crypto'

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
 * Clear the relay chain's downward message queues, in whichever layout the runtime stores them.
 *
 * polkadot-sdk stable2609 replaced the single `Dmp.DownwardMessageQueues` item with two paged
 * items, `DownwardMessageQueueMeta` and `DownwardMessageQueuePages` (polkadot-sdk#11909). The
 * fellowship runtimes pick this up in 2.6.0. Until 2.6.0 is enacted, the live chains have the
 * old item and the release candidates have the new ones. Chopsticks fails the whole setup when
 * it is told to clear an item the runtime does not have, so this function checks the metadata
 * first and clears what is actually there.
 *
 * One trap: new metadata does not mean the state has moved yet. When a fork loads a 2.6.0 wasm
 * on top of an older block, the messages are still stored under the old keys, and the runtime
 * migrates them into the paged queues in the next block, after this cleanup already ran. So the
 * old keys have to be deleted as well. The metadata no longer knows the old item, so its storage
 * prefix is computed here by hand.
 */
export async function clearDmpQueues(client: {
  api: { query: Record<string, any> }
  dev: { setStorage: (values: any) => Promise<any> }
}): Promise<void> {
  if (client.api.query.dmp?.downwardMessageQueueMeta) {
    await client.dev.setStorage({
      Dmp: { $removePrefix: ['downwardMessageQueueMeta', 'downwardMessageQueuePages'] },
    })
    const retiredPrefix = u8aToHex(u8aConcat(xxhashAsU8a('Dmp', 128), xxhashAsU8a('DownwardMessageQueues', 128)))
    await client.dev.setStorage([[retiredPrefix, 'DeletedPrefix']])
  } else if (client.api.query.dmp?.downwardMessageQueues) {
    await client.dev.setStorage({ Dmp: { $removePrefix: ['downwardMessageQueues'] } })
  }
}

export async function createNetwork<T extends Chain>(chainConfig: T) {
  const network = await setupContextWithBlockFallback(chainConfig)

  if (chainConfig.initStorages) {
    await network.dev.setStorage(chainConfig.initStorages)
  }

  // Messages that were in flight when the fork was taken can change test results, so every
  // relay chain starts with empty queues. This cannot live in the static chain definitions,
  // because which storage items to clear depends on the runtime; see `clearDmpQueues`.
  if (chainConfig.isRelayChain) {
    await clearDmpQueues(network as any)
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
