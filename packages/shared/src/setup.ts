import { afterAll, beforeEach } from 'vitest'

import { Chain, captureSnapshot, createNetworks } from '@e2e-test/networks'

export async function setupNetworks<T extends Chain[]>(...chains: T) {
  const networks = await createNetworks(...chains)

  const restoreSnapshot = captureSnapshot(...networks)

  beforeEach(restoreSnapshot)

  afterAll(async () => {
    await Promise.all(networks.map((network) => network.teardown()))
  })

  return networks
}
