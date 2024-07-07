import { describe, expect, it } from 'vitest'

import { acala, moonbeam } from './chains/index.js'
import { createNetwork } from './createNetwork.js'

describe('createNetwork', () => {
  it('chain config', () => {
    expect(acala.endpoint).toBeDefined()
    expect(acala.timeout).toBeDefined()
    expect(acala.initStorages).toBeDefined()
    expect(acala.custom).toBeDefined()
    expect(moonbeam.custom).toBeDefined()
  })

  it('createNetwork', async () => {
    const acalaClient = await createNetwork(acala)

    expect(acalaClient.chain).toBeDefined()
  })
})
