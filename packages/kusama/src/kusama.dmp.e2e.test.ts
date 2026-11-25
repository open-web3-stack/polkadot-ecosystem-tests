import { clearDmpQueues, createNetworks } from '@e2e-test/networks'
import { kusama } from '@e2e-test/networks/chains'

import { u8aConcat, u8aToHex } from '@polkadot/util'
import { xxhashAsU8a } from '@polkadot/util-crypto'

import { assert, test } from 'vitest'

const oldItemPrefix = () => u8aConcat(xxhashAsU8a('Dmp', 128), xxhashAsU8a('DownwardMessageQueues', 128))

const oldItemKey = (paraId: number) => {
  const id = new Uint8Array(4)
  new DataView(id.buffer).setUint32(0, paraId, true)
  return u8aToHex(u8aConcat(oldItemPrefix(), xxhashAsU8a(id, 64), id))
}

// Vec with one InboundDownwardMessage { sentAt: 1, msg: 0xdeadbeef }
const oldItemValue = '0x040100000010deadbeef'

/**
 * Regression test for `clearDmpQueues` on runtimes with paged DMP storage.
 *
 * polkadot-sdk stable2609 moved the relay chain's downward message queues to paged storage.
 * The old item, `DownwardMessageQueues`, is gone from the metadata, but a fork that loads a
 * 2.6.0 wasm on top of an older block still has its messages stored under the old keys. The
 * runtime migrates those messages into the paged queues in the next block. So a cleanup that
 * only clears the paged items loses: the old messages come back one block after it ran. The
 * cleanup has to delete the old keys too, and since the metadata no longer knows the old
 * item, it computes the storage prefix by hand.
 *
 * This situation only exists on a runtime with paged DMP, so the test skips on older
 * runtimes. It runs when CI overrides the chain with a 2.6.0 candidate wasm, and it will run
 * against the live chain once 2.6.0 is enacted.
 */
test('messages under the old DMP keys do not come back after the cleanup', async (ctx) => {
  const [client] = await createNetworks(kusama)
  try {
    if (!client.api.query.dmp.downwardMessageQueueMeta) {
      ctx.skip(true, 'the runtime does not have paged DMP storage yet')
      return
    }
    const key = oldItemKey(1000)

    // Control: show the problem is real. Put a message under the old keys, build a block,
    // and watch the runtime move it into the paged queues.
    await client.dev.setStorage([[key, oldItemValue]])
    await client.dev.newBlock({ count: 1 })
    const resurrected = await client.api.query.dmp.downwardMessageQueuePages.entries()
    assert(resurrected.length > 0, 'the control did not resurrect, so the test proves nothing')

    // Now the same thing with the cleanup in between: nothing comes back.
    await client.dev.setStorage([[key, oldItemValue]])
    await client.dev.setStorage({ Dmp: { $removePrefix: ['downwardMessageQueueMeta', 'downwardMessageQueuePages'] } })
    await clearDmpQueues(client)
    const leftover = await client.api.rpc.state.getKeysPaged(u8aToHex(oldItemPrefix()), 10)
    assert(leftover.length === 0, `the old prefix still has ${leftover.length} keys`)
    await client.dev.newBlock({ count: 1 })
    const pages = await client.api.query.dmp.downwardMessageQueuePages.entries()
    assert(pages.length === 0, `the paged queues gained ${pages.length} entries after the cleanup`)
  } finally {
    await client.teardown()
  }
}, 600000)
