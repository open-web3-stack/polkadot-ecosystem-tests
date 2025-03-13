import { assert, describe, test } from 'vitest'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'
import {
  check,
  checkEvents,
  checkSystemEvents,
  scheduleInlineCallWithOrigin,
  scheduleLookupCallWithOrigin,
} from './helpers/index.js'

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

const PERIOD = 2
const REPETITIONS = 3

/// -------
/// -------
/// -------

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
 * Scheduler tests rely on `scheduleInlineCallWithOrigin`, as there would otherwise be no way of scheduling a call
 * with the proper origin.
 */
export async function cancelScheduledTaskBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const call = client.api.tx.system.remark('test').method.toHex()
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 2, null, 0, call)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

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
 * Scheduler tests rely on `scheduleInlineCallWithOrigin`, as there would otherwise be no way of scheduling a call
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

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

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

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

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
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 1)
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

  scheduleInlineCallWithOrigin(client, scheduleNamedTx.method.toHex(), { system: 'Root' })

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
 * Test cancellation of scheduled task
 *
 * 1. create a `Root`-origin call
 * 2. schedule said call
 * 3. cancel the call
 * 4. verify that its data is removed from the agenda
 */
export async function cancelScheduledTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 3, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 2)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)

  const cancelTx = client.api.tx.scheduler.cancel(currBlockNumber + 2, 0)

  scheduleInlineCallWithOrigin(client, cancelTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

  // This should capture 2 system events, and no `TotalIssuanceForced`.
  // 1. One system event will be for the test-specific dispatch injected via the helper `scheduleInlineCallWithOrigin`
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
 * Test cancellation of a (named) scheduled task
 *
 * 1. create a `Root`-origin call
 * 2. schedule said call, with a name
 * 3. cancel the call
 * 4. verify that its data is removed from the agenda
 */
export async function cancelScheduledNamedTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const taskId = sha256AsU8a('task_id')

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber + 3, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleNamedTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 2)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)

  const cancelTx = client.api.tx.scheduler.cancelNamed(taskId)

  scheduleInlineCallWithOrigin(client, cancelTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

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
 * Test scheduling a task after a delay.
 */
export async function scheduleTaskAfterDelay<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleTx = client.api.tx.scheduler.scheduleAfter(1, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 0)

  await checkSystemEvents(client, 'scheduler').toMatchSnapshot('events when scheduling task with delay')

  await client.dev.newBlock()
  currBlockNumber += 1

  scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
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

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()
  currBlockNumber += 1

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' }).toMatchSnapshot(
    'events for scheduled task execution',
  )

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(oldTotalIssuance.addn(1)))

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 1)
  assert(scheduled.length === 0)
}

/**
 * Test scheduling a named task after a delay.
 */
export async function scheduleNamedTaskAfterDelay<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const taskId = sha256AsU8a('task_id')

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamedAfter(taskId, 1, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleNamedTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 0)

  await checkSystemEvents(client, 'scheduler').toMatchSnapshot('events when scheduling task with delay')

  await client.dev.newBlock()
  currBlockNumber += 1

  scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
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

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()
  currBlockNumber += 1

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' }).toMatchSnapshot(
    'events for scheduled task execution',
  )

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(oldTotalIssuance.addn(1)))

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 1)
  assert(scheduled.length === 0)
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

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })

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

/**
 * Test scheduling of preimage lookup call.
 *
 * 1. Create a call requiring a `Root` origin: an update to total issuance
 * 2. Note the call in storage for the `preimage` pallet
 * 3. Schedule the call
 * 4. Check that the call was executed
 *
 * As of Mar. 2025, this fails on the Collectives chain.
 * The issue has been fixed, and when it is upstreamed, this test can then be updated.
 * @param client
 */
async function scheduleLookupCall<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const encodedProposal = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1).method
  const preimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const preImageEvents = await sendTransaction(preimageTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')

  const preimageHash = encodedProposal.hash

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleLookupCallWithOrigin(
    client,
    { hash: preimageHash, len: encodedProposal.encodedLength },
    { system: 'Root' },
  )

  const agenda = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(agenda.length === 1)
  assert(agenda[0].isSome)
  const scheduledTask = agenda[0].unwrap()
  await check(scheduledTask).toMatchObject({
    maybeId: null,
    priority: 0,
    call: { lookup: { hash: preimageHash.toHex(), len: encodedProposal.encodedLength } },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  })

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()

  // Check if `parachainInfo` pallet exists
  const parachainInfo = client.api.query.parachainInfo
  if (parachainInfo) {
    // In the collectives chain, dispatch of lookup calls does not work at present.
    // Fix: https://github.com/polkadot-fellows/runtimes/pull/614
    if ((await parachainInfo.parachainId()).eq(1001)) {
      const newTotalIssuance = await client.api.query.balances.totalIssuance()
      assert(newTotalIssuance.eq(oldTotalIssuance))
    }
  } else {
    const newTotalIssuance = await client.api.query.balances.totalIssuance()
    assert(newTotalIssuance.eq(oldTotalIssuance.addn(1)))
  }

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' }).toMatchSnapshot(
    'events for scheduled lookup-task execution',
  )
}

/**
 * Helper function containing common logic for testing periodic tasks
 * Tests that:
 * 1. task executes at the correct intervals
 * 2. runs the expected number of executions
 * 3. task is removed from the agenda after all executions
 */
async function testPeriodicTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  client: Client<TCustom, TInitStorages>,
  scheduleTx: SubmittableExtrinsic<'promise', ISubmittableResult>,
  taskId: Uint8Array | null,
) {
  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' })
  const initialTotalIssuance = await client.api.query.balances.totalIssuance()
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  // Move to first execution block
  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await client.dev.newBlock()
  currBlockNumber += 1

  // Initial agenda check
  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject({
    maybeId: taskId ? `0x${Buffer.from(taskId).toString('hex')}` : null,
    priority: 0,
    call: { inline: adjustIssuanceTx.method.toHex() },
    // The number of repetitions is reduced by 1 because the first scheduled execution has already occurred:
    // it is exactly this task.
    maybePeriodic: [PERIOD, REPETITIONS - 1],
    origin: {
      system: {
        root: null,
      },
    },
  })

  // Run through the task's repetitions, and verify that
  // 1. it executes at the correct intervals,
  // 2. it runs the expected number of executions.
  // 3. the task is removed from the agenda after all executions.
  for (let i = 1; i <= REPETITIONS; i++) {
    // Execution block
    await client.dev.newBlock()
    currBlockNumber += 1

    await checkSystemEvents(client, 'scheduler', {
      section: 'balances',
      method: 'TotalIssuanceForced',
    }).toMatchSnapshot(`events for ${taskId ? 'named' : ''} periodic task execution ${i}`)

    const currentTotalIssuance = await client.api.query.balances.totalIssuance()
    assert(currentTotalIssuance.eq(initialTotalIssuance.addn(i)))

    // Check agenda for next scheduled execution (if not the last iteration)
    if (i < REPETITIONS) {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 2)
      assert(scheduled.length === 1)
      assert(scheduled[0].isSome)

      let maybePeriodic: [number, number] | null
      if (i === REPETITIONS - 1) {
        maybePeriodic = null
      } else {
        maybePeriodic = [PERIOD, REPETITIONS - (i + 1)]
      }

      await check(scheduled[0].unwrap()).toMatchObject({
        maybeId: taskId ? `0x${Buffer.from(taskId).toString('hex')}` : null,
        priority: 0,
        call: { inline: adjustIssuanceTx.method.toHex() },
        maybePeriodic: maybePeriodic,
        origin: {
          system: {
            root: null,
          },
        },
      })
    }

    // Skip one block (no execution)
    await client.dev.newBlock()
    currBlockNumber += 1
  }

  // Verify task is removed after all executions
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 0)
}

/**
 * Test the scheduling of a periodic task that executes multiple times:
 *
 * 1. Create a Root-origin call to adjust total issuance
 * 2. Schedule it to run every other block, starting 2 blocks after scheduling
 * 3. Verify it executes 3 times at the correct intervals
 */
export async function schedulePeriodicTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const scheduleTx = client.api.tx.scheduler.schedule(
    currBlockNumber + 2, // when
    [PERIOD, REPETITIONS], // maybe_periodic: [period, repetitions]
    0, // priority
    adjustIssuanceTx, // call
  )

  await testPeriodicTask(client, scheduleTx, null)
}

/**
 * Test scheduling a named periodic task that executes multiple times
 *
 * 1. Create a Root-origin call to adjust total issuance
 * 2. Schedule it with a name to run every other block, starting 2 blocks after scheduling
 * 3. Verify it executes 3 times at the correct intervals
 */
export async function scheduleNamedPeriodicTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const taskId = sha256AsU8a('task_id')
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(
    taskId, // id
    currBlockNumber + 2, // when
    [PERIOD, REPETITIONS], // maybe_periodic: [period, repetitions]
    0, // priority
    adjustIssuanceTx, // call
  )

  await testPeriodicTask(client, scheduleNamedTx, taskId)
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

    test('cancelling a named scheduled task is possible', async () => {
      await cancelScheduledNamedTask(client)
    })

    test('scheduling a task after a delay is possible', async () => {
      await scheduleTaskAfterDelay(client)
    })

    test('scheduling a periodic task is possible', async () => {
      await schedulePeriodicTask(client)
    })

    test('scheduling a named periodic task that executes multiple times', async () => {
      await scheduleNamedPeriodicTask(client)
    })

    test('scheduling a named task after a delay is possible', async () => {
      await scheduleNamedTaskAfterDelay(client)
    })

    test('scheduling an overweight call is possible, but the call itself fails', async () => {
      await scheduledOverweightCallFails(client)
    })

    test('execution of scheduled preimage lookup call works', async () => {
      await scheduleLookupCall(client)
    })
  })
}
