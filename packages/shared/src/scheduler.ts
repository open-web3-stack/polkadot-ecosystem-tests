import { assert, describe, test } from 'vitest'

import { type Chain, defaultAccountsSr25199 } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import { checkSystemEvents } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'

/**
 * Test the process of scheduling a call with a bad origin, and check that it fails.
 */
export async function scheduleBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25199.alice

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const call = client.api.tx.system.remark('test').method.toHex()

  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber, null, 0, call)
  await sendTransaction(scheduleTx.signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'events when scheduling task with insufficient origin',
  )

  // Check events

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isBadOrigin)
}

export function schedulerE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, () => {
    test('schedule task with wrong origin', async () => {
      await scheduleBadOriginTest(chain, testConfig.addressEncoding)
    })
  })
}
