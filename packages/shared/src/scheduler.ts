import { assert, describe, test } from 'vitest'

import { type Chain, defaultAccountsSr25199 } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import CryptoJS from 'crypto-js'
import { checkSystemEvents } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { ISubmittableResult } from '@polkadot/types/types'

/// -------
/// Helpers
/// -------

export async function badOriginHelper(client: any, scheduleTx: SubmittableExtrinsic<'promise', ISubmittableResult>) {
  const alice = defaultAccountsSr25199.alice

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

/// -------
/// -------
/// -------

// const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
// const call = client.api.tx.system.remark('test').method.toHex()
// client.api.tx.scheduler.schedule(currBlockNumber, null, 0, call)

/**
 * Test the process of scheduling a call with a bad origin, and check that it fails.
 */
export async function scheduleBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const call = client.api.tx.system.remark('test').method.toHex()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber, null, 0, call)

  await badOriginHelper(client, scheduleTx)
}

/**
 * Test the process of scheduling a named call with a bad origin, and check that it fails.
 */
export async function scheduleNamedBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const call = client.api.tx.system.remark('test').method.toHex()

  const hash = CryptoJS.SHA256('task_id')
  const buf = Buffer.from(hash.toString(CryptoJS.enc.Hex), 'hex')
  const taskId = new Uint8Array(buf)

  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber, null, 0, call)

  await badOriginHelper(client, scheduleTx)
}

export function schedulerE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, () => {
    test('schedule task with wrong origin', async () => {
      await scheduleBadOriginTest(chain)
    })

    test('schedule named task with wrong origin', async () => {
      await scheduleNamedBadOriginTest(chain)
    })
  })
}
