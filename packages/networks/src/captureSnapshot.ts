import type { Client } from './createNetwork.js'

export function captureSnapshot(...clients: Client[]) {
  const heads = clients.map((client) => {
    const block = client.chain.head
    const layerCount = (block as any).storageLayerCount ?? 0
    return [block, client.chain, layerCount] as const
  })
  return async () => {
    for (const [head, chain, layerCount] of heads) {
      await chain.setHead(head)
      ;(head as any).resetStorageLayers(layerCount)
    }
  }
}
