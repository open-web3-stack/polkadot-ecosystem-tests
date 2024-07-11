import { Client } from './createNetwork.js'

export function captureSnapshot(...clients: Client[]) {
  const heads = clients.map((client) => [client.chain.head, client.chain] as const)
  return async () => {
    for (const [head, chain] of heads) {
      await chain.setHead(head)
    }
  }
}
