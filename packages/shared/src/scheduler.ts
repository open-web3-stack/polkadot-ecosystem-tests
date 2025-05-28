import { assert, describe, expect, test } from 'vitest'

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
import type { PalletSchedulerScheduled, SpWeightsWeightV2Weight } from '@polkadot/types/lookup'
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

/**
 * The period of the periodic task.
 *
 * Used in test to scheduling of periodic tasks.
 */
const PERIOD = 2

/**
 * The number of repetitions that a given periodic task should run for.
 *
 * Used in test to scheduling of periodic tasks.
 */
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const call = client.api.tx.system.remark('test').method.toHex()
  const currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 1, null, 0, call)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  const scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
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

  const cancelTx = client.api.tx.scheduler.cancel(currBlockNumber + 1, 0)

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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const call = client.api.tx.system.remark('test').method.toHex()
  const currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()

  const taskId = sha256AsU8a('task_id')

  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber + 1, null, 0, call)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  const scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  // This offset was +2 previously, but with the AHM it becomes +1. The reason:
  // 1. consider a parachain P on block `p`
  // 2. the relay chain's last block number (known to parachain P) is `r`
  // 3. a task scheduled to run on parachain P, with an agenda key of `r + 1`
  // If parachain P advances to `p + 1` *and* the relay's last known block to `r + 1`, the task will *not* execute yet.
  // Instead, only when P moves to `p + 2` and P's view of the relay to `r + 2` will the task execute.
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 1, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
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

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const taskId = sha256AsU8a('task_id')

  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber + 1, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleNamedTx.method.toHex(), { system: 'Root' }, 'SysPara')

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
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

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(oldTotalIssuance.addn(1)))

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 1)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 1, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)

  const cancelTx = client.api.tx.scheduler.cancel(currBlockNumber + 1, 0)

  scheduleInlineCallWithOrigin(client, cancelTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()
  currBlockNumber += 1

  // This should capture 2 system events, and no `TotalIssuanceForced`.
  // 1. One system event will be for the test-specific dispatch injected via the helper `scheduleInlineCallWithOrigin`
  // 2. The other will be for the cancellation of the scheduled task
  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task cancellation')

  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const taskId = sha256AsU8a('task_id')

  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(taskId, currBlockNumber + 2, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleNamedTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)

  const cancelTx = client.api.tx.scheduler.cancelNamed(taskId)

  scheduleInlineCallWithOrigin(client, cancelTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()
  currBlockNumber += 1

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /when|task/,
    })
    .toMatchSnapshot('events for scheduled task cancellation')

  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const scheduleTx = client.api.tx.scheduler.scheduleAfter(1, null, 0, adjustIssuanceTx)

  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()
  currBlockNumber += 1

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
  assert(scheduled.length === 0)

  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /when|task/,
    })
    .toMatchSnapshot('events when scheduling task with delay')

  await client.dev.newBlock()
  currBlockNumber += 1

  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
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

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const taskId = sha256AsU8a('task_id')

  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamedAfter(taskId, 1, null, 0, adjustIssuanceTx)

  await scheduleInlineCallWithOrigin(client, scheduleNamedTx.method.toHex(), { system: 'Root' }, 'SysPara')

  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
  expect(scheduled.length).toBe(1)

  await client.dev.newBlock()
  currBlockNumber += 1

  // The previously scheduled task should have been executed and removed from the agenda.
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 1)
  assert(scheduled.length === 0)

  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /when|task/,
    })
    .toMatchSnapshot('events when scheduling task with delay')

  await client.dev.newBlock()
  currBlockNumber += 1

  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
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

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Call whose weight will be artifically inflated
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  // Network's maximum allowed weight for a block's entirety of scheduled calls.
  const maxWeight = client.api.consts.scheduler.maximumWeight

  const withWeightTx = client.api.tx.utility.withWeight(adjustIssuanceTx, maxWeight)

  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const scheduleTx = client.api.tx.scheduler.schedule(currBlockNumber + 1, null, 0, withWeightTx)

  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  currBlockNumber += 1
  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber)

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

  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task/,
    })
    .toMatchSnapshot('events when scheduling overweight task')

  // Check that the call remains in the agenda for the original block it was scheduled in
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 1)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const encodedProposal = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1).method
  const preimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const preImageEvents = await sendTransaction(preimageTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')

  const preimageHash = encodedProposal.hash

  const currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  await scheduleLookupCallWithOrigin(
    client,
    { hash: preimageHash, len: encodedProposal.encodedLength },
    { system: 'Root' },
    true,
  )

  const agenda = await client.api.query.scheduler.agenda(currBlockNumber)
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

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(oldTotalIssuance.addn(1)))

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|task/,
    })
    .toMatchSnapshot('events for scheduled lookup-task execution')
}

/**
 * Test scheduling a call using a preimage that gets removed:
 *
 * 1. Note a preimage for a call that adjusts total issuance
 * 2. Schedule the preimaged call
 * 3. Remove the preimage
 * 4. Move to execution block
 */
export async function schedulePreimagedCall<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const encodedProposal = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1).method

  // Note the preimage
  const noteTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const noteEvents = await sendTransaction(noteTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkEvents(noteEvents, 'preimage').toMatchSnapshot('note preimage events')

  // Schedule using the preimage hash
  const blockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()

  await client.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [blockNumber + 1],
          [
            {
              call: {
                lookup: {
                  hash: encodedProposal.hash.toHex(),
                  len: encodedProposal.encodedLength,
                },
              },
              origin: {
                system: 'Root',
              },
            },
          ],
        ],
      ],
    },
  })

  let scheduled = await client.api.query.scheduler.agenda(blockNumber + 1)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  expect(scheduled[0].toJSON()).toMatchObject({
    maybeId: null,
    priority: 0,
    call: {
      lookup: {
        hash: encodedProposal.hash.toHex(),
        len: encodedProposal.encodedLength,
      },
    },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  })

  // Unnote the preimage
  const unnoteTx = client.api.tx.preimage.unnotePreimage(encodedProposal.hash.toHex())
  await unnoteTx.signAndSend(defaultAccountsSr25519.alice)
  await client.dev.newBlock()

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  // Move to execution block
  await client.dev.newBlock()

  scheduled = await client.api.query.scheduler.agenda(blockNumber + 1)

  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  expect(scheduled[0].toJSON()).toMatchObject({
    maybeId: null,
    priority: 0,
  })

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /task/,
    })
    .toMatchSnapshot('events for failing scheduled lookup-task execution')

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(newTotalIssuance.eq(oldTotalIssuance))
}

/**
 * Helper function containing common logic for testing periodic tasks.
 *
 * Tests that:
 * 1. task executes at the correct intervals
 * 2. it runs the expected number of executions, and that
 * 3. the task is removed from the agenda after all executions
 */
async function testPeriodicTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  client: Client<TCustom, TInitStorages>,
  scheduleTx: SubmittableExtrinsic<'promise', ISubmittableResult>,
  taskId: Uint8Array | null,
) {
  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')
  const initialTotalIssuance = await client.api.query.balances.totalIssuance()
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  // Move to first execution block
  let currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  await client.dev.newBlock()
  currBlockNumber += 1

  // Initial agenda check
  let scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject({
    maybeId: taskId ? `0x${Buffer.from(taskId).toString('hex')}` : null,
    priority: 0,
    call: { inline: adjustIssuanceTx.method.toHex() },
    // The number of repetitions has already been reduced by 1 because the first scheduled execution has already
    // occurred: it is exactly this task.
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
    })
      .redact({
        redactKeys: /new|old|task|when/,
      })
      .toMatchSnapshot(`events for ${taskId ? 'named' : ''} periodic task execution ${i}`)

    const currentTotalIssuance = await client.api.query.balances.totalIssuance()
    assert(currentTotalIssuance.eq(initialTotalIssuance.addn(i)))

    // Check agenda for next scheduled execution (if not the last iteration)
    if (i < REPETITIONS) {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber + 1)
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
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()

  const scheduleTx = client.api.tx.scheduler.schedule(
    currBlockNumber + 1, // when
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const taskId = sha256AsU8a('task_id')
  const currBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()

  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(
    taskId, // id
    currBlockNumber + 1, // when
    [PERIOD, REPETITIONS], // maybe_periodic: [period, repetitions]
    0, // priority
    adjustIssuanceTx, // call
  )

  await testPeriodicTask(client, scheduleNamedTx, taskId)
}

/**
 * Test priority-based execution of weighted tasks:
 * 1. Create two transactions with weights that exceed half the maximum weight per block
 * 2. Schedule them for the same block with different priorities
 * 3. Verify that:
 *    - The higher priority task executes first and is removed from agenda
 *    - The lower priority task is not executed in the first block
 *    - The lower priority task is executed in the second block
 *    - The `incompleteSince` storage is updated correctly
 */
export async function schedulePriorityWeightedTasks<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceHighTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 2)
  const adjustIssuanceLowTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  // Get the maximum weight schedulable per block, and create tasks that each use 60% of it.
  const { refTime, proofSize }: SpWeightsWeightV2Weight = client.api.consts.scheduler.maximumWeight
  const taskWeight = {
    refTime: refTime.unwrap().muln(60).divn(100),
    proofSize: proofSize.unwrap().muln(60).divn(100),
  }

  const highPriorityTx = client.api.tx.utility.withWeight(adjustIssuanceHighTx, taskWeight)
  const lowPriorityTx = client.api.tx.utility.withWeight(adjustIssuanceLowTx, taskWeight)

  const initBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()
  const targetBlock = initBlockNumber + 1

  // Schedule both tasks for the same block with different priorities
  const scheduleHighPriorityTx = client.api.tx.scheduler.schedule(
    targetBlock,
    null,
    0, // higher priority
    highPriorityTx,
  )
  const scheduleLowPriorityTx = client.api.tx.scheduler.schedule(
    targetBlock,
    null,
    1, // lower priority
    lowPriorityTx,
  )

  // Schedule both tasks
  await client.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [initBlockNumber],
          [
            {
              call: { Inline: scheduleLowPriorityTx.method.toHex() },
              origin: { system: 'Root' },
            },
            {
              call: { Inline: scheduleHighPriorityTx.method.toHex() },
              origin: { system: 'Root' },
            },
          ],
        ],
      ],
    },
  })

  const initialTotalIssuance = await client.api.query.balances.totalIssuance()

  // Move to block just before scheduled execution
  await client.dev.newBlock()

  // Verify both tasks are in the agenda
  let scheduled = await client.api.query.scheduler.agenda(targetBlock)
  assert(scheduled.length === 2)
  assert(scheduled[0].isSome && scheduled[1].isSome)

  // Execute first block - should only complete high priority task
  await client.dev.newBlock()

  // Check events - there should only be one execution
  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|task/,
    })
    .toMatchSnapshot('events for priority weighted tasks execution')

  // Check that *only* the high priority task executed
  const midTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(midTotalIssuance.eq(initialTotalIssuance.addn(2)))

  // Verify `incompleteSince` is set to current block
  const incompleteSince = await client.api.query.scheduler.incompleteSince()
  assert(incompleteSince.isSome)
  assert(incompleteSince.unwrap().eq(targetBlock))

  scheduled = await client.api.query.scheduler.agenda(targetBlock)
  assert(scheduled.length === 2)
  assert(scheduled[0].isSome && scheduled[1].isNone)
  await check(scheduled[0].unwrap()).toMatchObject({
    maybeId: null,
    priority: 1,
    call: { inline: lowPriorityTx.method.toHex() },
    maybePeriodic: null,
    origin: { system: { root: null } },
  })

  // Move to the next block, where the lower priority task will execute
  await client.dev.newBlock()

  const finalTotalIssuance = await client.api.query.balances.totalIssuance()
  assert(finalTotalIssuance.eq(initialTotalIssuance.addn(3)))

  // Verify `incompleteSince` has been unset
  const finalIncompleteSince = await client.api.query.scheduler.incompleteSince()
  assert(finalIncompleteSince.isNone)

  // Verify agenda is now empty
  scheduled = await client.api.query.scheduler.agenda(initBlockNumber)
  assert(scheduled.length === 0)
  scheduled = await client.api.query.scheduler.agenda(targetBlock)
  assert(scheduled.length === 0)
  scheduled = await client.api.query.scheduler.agenda(targetBlock + 1)
  assert(scheduled.length === 0)
}

/**
 * Test setting and canceling retry configuration for unnamed scheduled tasks:
 *
 * 1. Create and schedule a task that will fail
 *    - `remarkWithEvent` fails with `Root` origin
 * 2. Set retry configuration using `scheduler.setRetry`
 * 3. Verify task fails and is rescheduled per its retry config
 * 4. Cancel the retry configuration
 * 5. Verify the task remains scheduled but without its retry config
 */
export async function scheduleWithRetryConfig<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Create a task that will fail - remarkWithEvent requires signed origin
  const failingTx = client.api.tx.system.remarkWithEvent('will_fail')
  const initialBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()

  // Define base task object once
  const baseTask = {
    maybeId: null,
    priority: 1,
    call: { inline: failingTx.method.toHex() },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  }

  const retryConfig = {
    totalRetries: 3,
    remaining: 3,
    period: 3,
  }

  // Schedule the task first
  const scheduleTx = client.api.tx.scheduler.schedule(initialBlockNumber + 2, null, 1, failingTx)
  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  // Move to scheduling block
  await client.dev.newBlock()

  // Check initial schedule
  let scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 2)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject(baseTask)

  // Set retry configuration
  const setRetryTx = client.api.tx.scheduler.setRetry(
    [initialBlockNumber + 2, 0],
    retryConfig.totalRetries,
    retryConfig.period,
  )
  scheduleInlineCallWithOrigin(client, setRetryTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  let retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 2, 0])
  assert(retryOpt.isSome)
  let retry = retryOpt.unwrap()
  await check(retry).toMatchObject(retryConfig)

  // Move to block of first execution
  await client.dev.newBlock()

  // Check failure events
  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task|when/,
    })
    .toMatchSnapshot('events for failed task execution')

  // Verify task failed and was rescheduled
  scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 2)
  assert(scheduled.length === 0)
  scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 5)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject(baseTask)

  retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 5, 0])
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 1,
  })

  const cancelRetryTx = client.api.tx.scheduler.cancelRetry([initialBlockNumber + 5, 0])
  scheduleInlineCallWithOrigin(client, cancelRetryTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  // Check retry cancellation events
  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task/,
    })
    .toMatchSnapshot('events for retry config cancellation')

  await client.dev.newBlock()

  // Verify task is still scheduled but without retry config
  scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 5)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject(baseTask)

  retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 5, 0])
  assert(retryOpt.isNone)
}

/**
 * Test setting and canceling retry configuration for named scheduled tasks:
 *
 * 1. Create and schedule a named task that will fail
 *    - `remarkWithEvent` fails with `Root` origin
 * 2. Set retry configuration using `scheduler.setRetryNamed`
 * 3. Verify task fails and is rescheduled per its retry config
 * 4. Cancel the retry configuration
 * 5. Verify the task remains scheduled but without its retry config
 */
export async function scheduleNamedWithRetryConfig<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Create a task that will fail - remarkWithEvent requires signed origin
  const failingTx = client.api.tx.system.remarkWithEvent('will_fail')
  const taskId = sha256AsU8a('retry_task')
  const initialBlockNumber = (await client.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()

  // Define base task object once
  const baseTask = {
    maybeId: `0x${Buffer.from(taskId).toString('hex')}`,
    priority: 1,
    call: { inline: failingTx.method.toHex() },
    maybePeriodic: null,
    origin: {
      system: {
        root: null,
      },
    },
  }

  const retryConfig = {
    totalRetries: 3,
    remaining: 3,
    period: 3,
  }

  // Schedule the named task first
  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, initialBlockNumber + 2, null, 1, failingTx)
  scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, 'SysPara')

  // Move to scheduling block
  await client.dev.newBlock()

  // Check initial schedule
  let scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 2)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject(baseTask)

  // Set retry configuration
  const setRetryTx = client.api.tx.scheduler.setRetryNamed(taskId, retryConfig.totalRetries, retryConfig.period)
  scheduleInlineCallWithOrigin(client, setRetryTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  let retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 2, 0])
  assert(retryOpt.isSome)
  let retry = retryOpt.unwrap()
  await check(retry).toMatchObject(retryConfig)

  // Move to block of first execution
  await client.dev.newBlock()

  // Check failure events
  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task|when/,
    })
    .toMatchSnapshot('events for failed named task execution')

  // Verify task failed and was rescheduled
  scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 2)
  assert(scheduled.length === 0)
  scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 5)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  // Retries of named tasks have no id
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })

  retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 5, 0])
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 1,
  })

  let cancelRetryTx = client.api.tx.scheduler.cancelRetryNamed(taskId)
  scheduleInlineCallWithOrigin(client, cancelRetryTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  // Check retry cancellation events
  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task/,
    })
    .toMatchSnapshot('events for retry config cancellation')

  await client.dev.newBlock()

  // Verify task is still scheduled but without retry config
  scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 5)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  // Once again - retries of named tasks have no id, even after removal of retry config
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })

  retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 5, 0])
  // A named task's retry will be unnamed, so its retry configuration must be cancelled
  // via `cancelRetry` - `cancelRetryNamed` has no effect.
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 1,
  })

  await client.dev.newBlock()

  // In the meantime, the task has been retried a second time, and has scheduled for a third

  scheduled = await client.api.query.scheduler.agenda(initialBlockNumber + 8)
  assert(scheduled.length === 1)
  assert(scheduled[0].isSome)
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })
  retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 8, 0])
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 2,
  })

  // Cancel the retry configuration with `cancelRetry`
  cancelRetryTx = client.api.tx.scheduler.cancelRetry([initialBlockNumber + 8, 0])
  scheduleInlineCallWithOrigin(client, cancelRetryTx.method.toHex(), { system: 'Root' }, 'SysPara')

  await client.dev.newBlock()

  retryOpt = await client.api.query.scheduler.retries([initialBlockNumber + 8, 0])
  assert(retryOpt.isNone)
}

export function schedulerE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, async () => {
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

    test('scheduling a call is possible, and the call itself succeeds', async () => {
      await scheduledCallExecutes(chain)
    })

    test('scheduling a named call is possible, and the call itself succeeds', async () => {
      await scheduledNamedCallExecutes(chain)
    })

    test('cancelling a scheduled task is possible', async () => {
      await cancelScheduledTask(chain)
    })

    test('cancelling a named scheduled task is possible', async () => {
      await cancelScheduledNamedTask(chain)
    })

    test('scheduling a task after a delay is possible', async () => {
      await scheduleTaskAfterDelay(chain)
    })

    test('scheduling a periodic task is possible', async () => {
      await schedulePeriodicTask(chain)
    })

    test('scheduling a named periodic task that executes multiple times', async () => {
      await scheduleNamedPeriodicTask(chain)
    })

    test('scheduling a named task after a delay is possible', async () => {
      await scheduleNamedTaskAfterDelay(chain)
    })

    test('scheduling an overweight call is possible, but the call itself fails', async () => {
      await scheduledOverweightCallFails(chain)
    })

    test('execution of scheduled preimage lookup call works', async () => {
      await scheduleLookupCall(chain)
    })

    test('scheduling a call using a preimage that gets removed', async () => {
      await schedulePreimagedCall(chain)
    })

    test('priority-based execution of weighted tasks works correctly', async () => {
      await schedulePriorityWeightedTasks(chain)
    })

    test('setting and canceling retry configuration for unnamed scheduled tasks', async () => {
      await scheduleWithRetryConfig(chain)
    })

    test('setting and canceling retry configuration for named scheduled tasks', async () => {
      await scheduleNamedWithRetryConfig(chain)
    })
  })
}
