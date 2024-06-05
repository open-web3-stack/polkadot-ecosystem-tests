import { describe, expect, it } from 'vitest'

import { acala, moonbeam } from './chains/index.js'
import { acalaNext } from './chains/acala-next.js'
import { createNetwork } from './createNetwork.js'

describe('createNetwork', () => {
  it('chain config', () => {
    expect(acala.endpoint).toBeDefined()
    expect(acala.timeout).toBeDefined()
    expect(acala.initStorages).toBeDefined()
    expect(acala.custom).toBeDefined()
    expect(moonbeam.custom).not.toBeDefined()
    expect(acalaNext.name).toBe('acalaNext')
  })

  it('createNetwork', async () => {
    const acalaNextClient = await createNetwork(acalaNext)

    expect(acalaNextClient.chain).toBeDefined()
  })
})
