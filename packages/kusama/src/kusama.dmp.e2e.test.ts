import { clearDmpQueues, createNetworks } from '@e2e-test/networks'
import { kusama } from '@e2e-test/networks/chains'

import { u8aConcat, u8aToHex } from '@polkadot/util'
import { xxhashAsU8a } from '@polkadot/util-crypto'

import { assert, test } from 'vitest'

const retiredPrefix = () => u8aConcat(xxhashAsU8a('Dmp', 128), xxhashAsU8a('DownwardMessageQueues', 128))

const retiredKey = (paraId: number) => {
  const id = new Uint8Array(4)
  new DataView(id.buffer).setUint32(0, paraId, true)
  return u8aToHex(u8aConcat(retiredPrefix(), xxhashAsU8a(id, 64), id))
}

// Vec with one InboundDownwardMessage { sentAt: 1, msg: 0xdeadbeef }
const retiredValue = '0x040100000010deadbeef'

/**
 * Regression case for the paged-DMP cleanup in `clearDmpQueues`.
 *
 * polkadot-sdk stable2609 moved the DMP queues to paged storage, and the runtime migrates
 * entries it finds under the retired `DownwardMessageQueues` prefix. A fork that overrides
 * a pre-upgrade block therefore resurrects retired-prefix messages into the paged queues
 * one block later, which is exactly the fork traffic the cleanup exists to remove. The
 * cleanup must delete the retired prefix too, by raw key, since the paged metadata cannot
 * name it.
 *
 * The test needs a paged-DMP runtime: it runs under a 2.6.0+ wasm override and after
 * enactment, and skips on earlier runtimes.
 */
test('retired DMP entries neither survive the cleanup nor resurrect', async (ctx) => {
  const [client] = await createNetworks(kusama)
  try {
    if (!client.api.query.dmp.downwardMessageQueueMeta) {
      ctx.skip(true, 'the runtime does not have paged DMP storage yet')
      return
    }
    const key = retiredKey(1000)

    // Control: an entry under the retired prefix resurrects into the paged queues.
    await client.dev.setStorage([[key, retiredValue]])
    await client.dev.newBlock({ count: 1 })
    const resurrected = await client.api.query.dmp.downwardMessageQueuePages.entries()
    assert(resurrected.length > 0, 'the control did not resurrect, so the test proves nothing')

    // The cleanup deletes the retired prefix, so nothing resurrects.
    await client.dev.setStorage([[key, retiredValue]])
    await client.dev.setStorage({ Dmp: { $removePrefix: ['downwardMessageQueueMeta', 'downwardMessageQueuePages'] } })
    await clearDmpQueues(client)
    const retired = await client.api.rpc.state.getKeysPaged(u8aToHex(retiredPrefix()), 10)
    assert(retired.length === 0, `the retired prefix still has ${retired.length} keys`)
    await client.dev.newBlock({ count: 1 })
    const pages = await client.api.query.dmp.downwardMessageQueuePages.entries()
    assert(pages.length === 0, `the paged queues gained ${pages.length} entries after the cleanup`)
  } finally {
    await client.teardown()
  }
}, 600000)
