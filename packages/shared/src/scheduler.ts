import { assert, describe, test } from 'vitest'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import CryptoJS from 'crypto-js'
import { check, checkSystemEvents, scheduleCallWithOrigin } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { Option } from '@polkadot/types'
import type { PalletSchedulerScheduled } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'

/// -------
/// Helpers
/// -------

export async function badOriginHelper(
  client: any,
  scheduleTx: SubmittableExtrinsic<'promise', ISubmittableResult>,
  snapshotDescription: string,
) {
  const alice = defaultAccountsSr25519.alice

  await sendTransaction(scheduleTx.signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(snapshotDescription)

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

  await badOriginHelper(client, scheduleTx, 'events when scheduling task with insufficient origin')
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

  await badOriginHelper(client, scheduleTx, 'events when scheduling named task with insufficient origin')
}

/**
 * Test the process of
 *
 * 1. scheduling a call with an origin fulfilling `SchedulOrigin`
 * 2. cancelling the call with a bad origin
 *
 * Scheduler tests rely on `scheduleCallWithOrigin`, as there would otherwise be no way of scheduling a call
 * with the proper origin.
 */
export async function cancelScheduledTaskBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const call = client.api.tx.system.remark('test').method.toHex()
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 2, null, 0, call)

  scheduleCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  const scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 2)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject({
    maybeId: null,
    priority: 0,
    call: { inline: call },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  })

  const cancelTx = client.api.tx.scheduler.cancel(currBlockNumber + 2, 0)

  await badOriginHelper(client, cancelTx, 'events when cancelling task with insufficient origin')
}

/**
 * Test the process of
 *
 * 1. scheduling a named call with an origin fulfilling `SchedulOrigin`
 * 2. cancelling the call with a bad origin
 *
 * Scheduler tests rely on `scheduleCallWithOrigin`, as there would otherwise be no way of scheduling a call
 * with the proper origin.
 */
export async function cancelNamedScheduledTaskBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const call = client.api.tx.system.remark('test').method.toHex()
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const hash = CryptoJS.SHA256('task_id')
  const buf = Buffer.from(hash.toString(CryptoJS.enc.Hex), 'hex')
  const taskId = new Uint8Array(buf)

  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber + 2, null, 0, call)

  scheduleCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  const scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 2)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap())
    .redact({ redactKeys: /maybeId/ })
    .toMatchObject({
      priority: 0,
      call: { inline: call },
      maybePeriodic: null,
      origin: {
        system: {
          root: null,
        },
      },
    })
  assert(scheduled[0].unwrap().maybeId.eq(taskId))

  const cancelTx = client.api.tx.scheduler.cancelNamed(taskId)

  await badOriginHelper(client, cancelTx, 'events when cancelling named task with insufficient origin')
}

export async function experiment<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  // Call whose weight will be artifically inflated
  const remarkTx = client.api.tx.system.remark('test')
  const remarkTxSigned = await remarkTx.signAsync(defaultAccountsSr25519.alice)
  // Network's maximum allowed weight for scheduled calls.
  const { refTime, proofSize } = client.api.consts.scheduler.maximumWeight

  const maxWeight = { refTime: refTime.unwrap().toBn(), proofSize: proofSize.unwrap().toBn() }
  maxWeight.refTime = maxWeight.refTime.divn(10)
  maxWeight.proofSize = maxWeight.proofSize.divn(10)

  //const withWeightTx = client.api.tx.utility.withWeight(remarkTxSigned, maxWeight)

  console.log((await client.api.call.transactionPaymentCallApi.queryCallInfo(remarkTxSigned, 0)).toHuman())

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 2, null, 0, adjustIssuanceTx)

  scheduleCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  await client.pause()

  await client.dev.newBlock()

  await client.pause()

  let scheduled: Vec<Option<PalletSchedulerScheduled>> = null
  for (let i = 0; i < 4; i++) {
    scheduled = await client.api.query.scheduler.agenda(currBlockNumber + i)
    console.log(scheduled.toHuman())
  }

  await client.dev.newBlock()

  for (let i = 0; i < 4; i++) {
    scheduled = await client.api.query.scheduler.agenda(currBlockNumber + i)
    console.log(scheduled.toHuman())
  }

  await client.dev.newBlock()

  for (let i = 0; i < 4; i++) {
    scheduled = await client.api.query.scheduler.agenda(currBlockNumber + i)
    console.log(scheduled.toHuman())
  }
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

    test('cancel scheduled task with wrong origin', async () => {
      await cancelScheduledTaskBadOriginTest(chain)
    })

    test('cancel named scheduled task with wrong origin', async () => {
      await cancelNamedScheduledTaskBadOriginTest(chain)
    })

    test('experiment', async () => {
      await experiment(chain)
    })
  })
}
