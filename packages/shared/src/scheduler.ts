import { assert, describe, test } from 'vitest'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'
import { check, checkSystemEvents, scheduleCallWithOrigin } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { PalletSchedulerScheduled } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'

import { sha256AsU8a } from '@polkadot/util-crypto'

/// -------
/// Helpers
/// -------

export async function badOriginHelper<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  client: Client<TCustom, TInitStorages>,
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
>(client: Client<TCustom, TInitStorages>) {
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
>(client: Client<TCustom, TInitStorages>) {
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const call = client.api.tx.system.remark('test').method.toHex()

  const taskId = sha256AsU8a('task_id')

  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber, null, 0, call)

  await badOriginHelper(client, scheduleTx, 'events when scheduling named task with insufficient origin')
}

/**
 * Test the process of
 *
 * 1. scheduling a call with an origin fulfilling `ScheduleOrigin`
 * 2. cancelling the call with a bad origin
 *
 * Scheduler tests rely on `scheduleCallWithOrigin`, as there would otherwise be no way of scheduling a call
 * with the proper origin.
 */
export async function cancelScheduledTaskBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
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
 * 1. scheduling a named call with an origin fulfilling `ScheduleOrigin`
 * 2. cancelling the call with a bad origin
 *
 * Scheduler tests rely on `scheduleCallWithOrigin`, as there would otherwise be no way of scheduling a call
 * with the proper origin.
 */
export async function cancelNamedScheduledTaskBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const call = client.api.tx.system.remark('test').method.toHex()
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const taskId = sha256AsU8a('task_id')

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

/**
 * Test the process of
 *
 * 1. creating a call requiring a `Root` origin: an update to total issuance
 * 2. scheduling it
 * 3. checking that the call was executed
 */

export async function scheduledCallExecutes<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 2, null, 0, adjustIssuanceTx)

  scheduleCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)

  await check(scheduled[0].unwrap()).toMatchObject({
    maybeId: null,
    priority: 0,
    call: { inline: adjustIssuanceTx.method.toHex() },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  })

  await client.dev.newBlock()
  currBlockNumber += 1

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' }).toMatchSnapshot(
    'events for scheduled task execution',
  )

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(oldTotalIssuance.addn(1)))

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
  assert(scheduled.length === 0)
}

/**
 * Test the process of
 *
 * 1. creating a call requiring a `Root` origin: an update to total issuance
 * 2. scheduling it, with a name
 * 3. checking that the call was executed
 */

export async function scheduledNamedCallExecutes<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const taskId = sha256AsU8a('task_id')

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber + 2, null, 0, adjustIssuanceTx)

  scheduleCallWithOrigin(client, scheduleNamedTx.method.toHex(), { system: 'Root' })

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)

  await check(scheduled[0].unwrap()).toMatchObject({
    maybeId: `0x${Buffer.from(taskId).toString('hex')}`,
    priority: 0,
    call: { inline: adjustIssuanceTx.method.toHex() },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  })

  await client.dev.newBlock()
  currBlockNumber += 1

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' }).toMatchSnapshot(
    'events for scheduled task execution',
  )

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(oldTotalIssuance.addn(1)))

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
  assert(scheduled.length === 0)
}

/**
 * Test to cancellation fo scheduled task
 *
 * 1. create a `Root`-origin call
 * 2. schedule said call
 * 3. cancel the call
 * 4. verify that it's data is removed from the agenda
 */
export async function cancelScheduledTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 3, null, 0, adjustIssuanceTx)

  scheduleCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 2)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)

  const cancelTx = client.api.tx.scheduler.cancel(currBlockNumber + 2, 0)

  scheduleCallWithOrigin(client, cancelTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

  // This should capture 2 system events, and no `TotalIssuanceForced`.
  // 1. One system event will be for the test-specific dispatch injected via the helper `scheduleCallWithOrigin`
  // 2. The other will be for the cancellation of the scheduled task
  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' }).toMatchSnapshot(
    'events for scheduled task cancellation',
  )

  scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 0)

  await client.dev.newBlock()

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' }).toMatchSnapshot(
    'empty event for cancelled task',
  )
}

/**
 * Test the process of
 *
 * 1. creating a call requiring a `Root` origin: an update to total issuance
 * 2. artificially manipulating that call's weight to the per-block weight limit allotted to scheduled calls
 * 3. scheduling the call
 * 4. checking that the call was not executed
 * 5. checking that it remains in the agenda for the original block it was scheduled in
 * @param chain
 *
 */
export async function scheduledOverweightCallFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // Call whose weight will be artifically inflated
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  // Network's maximum allowed weight for a block's entirety of scheduled calls.
  const maxWeight = client.api.consts.scheduler.maximumWeight

  const withWeightTx = client.api.tx.utility.withWeight(adjustIssuanceTx, maxWeight)

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 2, null, 0, withWeightTx)

  scheduleCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  currBlockNumber += 1
  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)

  assert(scheduled.length === 1)
  const scheduledTask: PalletSchedulerScheduled = scheduled[0].unwrap()
  const task = {
    maybeId: null,
    priority: 0,
    call: { inline: withWeightTx.method.toHex() },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  }
  await check(scheduledTask).toMatchObject(task)

  // Get current total issuance
  const totalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()

  currBlockNumber += 1

  // Check that the call was not executed
  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(totalIssuance))

  // Check that an event was emitted certifying the scheduled call as overweight

  await checkSystemEvents(client, 'scheduler').toMatchSnapshot('events when scheduling overweight task')

  // Check that the call remains in the agenda for the original block it was scheduled in
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
  assert(scheduled.length === 1)

  await check(scheduled[0].unwrap()).toMatchObject(task)
}

export function schedulerE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, async () => {
    const [client] = await setupNetworks(chain)

    test('schedule task with wrong origin', async () => {
      await scheduleBadOriginTest(client)
    })

    test('schedule named task with wrong origin', async () => {
      await scheduleNamedBadOriginTest(client)
    })

    test('cancel scheduled task with wrong origin', async () => {
      await cancelScheduledTaskBadOriginTest(client)
    })

    test('cancel named scheduled task with wrong origin', async () => {
      await cancelNamedScheduledTaskBadOriginTest(client)
    })

    test('scheduling a call is possible, and the call itself succeeds', async () => {
      await scheduledCallExecutes(client)
    })

    test('scheduling a named call is possible, and the call itself succeeds', async () => {
      await scheduledNamedCallExecutes(client)
    })

    test('cancelling a scheduled task is possible', async () => {
      await cancelScheduledTask(client)
    })

    test('scheduling an overweight call is possible, but the call itself fails', async () => {
      await scheduledOverweightCallFails(client)
    })
  })
}
