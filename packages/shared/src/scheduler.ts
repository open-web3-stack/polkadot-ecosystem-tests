import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { PalletSchedulerScheduled, SpWeightsWeightV2Weight } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { sha256AsU8a } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { match } from 'ts-pattern'
import {
  check,
  checkEvents,
  checkSystemEvents,
  getBlockNumber,
  nextSchedulableBlockNum,
  scheduleInlineCallWithOrigin,
  scheduleLookupCallWithOrigin,
  schedulerOffset,
  type TestConfig,
} from './helpers/index.js'

/**
 * Note on manually injecting tasks into the scheduler pallet's agenda storage.
 *
 * Scheduling extrinsics usually require supra-signed origins.
 *
 * The manual injection of tasks into the scheduler pallet's agenda storage could be used to simulate the execution of
 * the scheduling extrinsics themselves by placing into the agenda what the scheduling extrinsics themselves would
 * have placed, in case of a successful execution.
 * However, this would not allow exercise their control flows.
 *
 * Without this injection technique, it is also not easy to use `chopsticks` to test calls requiring `Root` or other
 * origins.
 *
 * So, a compromise is to manually inject the `schedule` calls themselves.
 */

/**
 * Note on relaychain vs parachain scheduler agenda keying.
 *
 * On parachains using the scheduler pallet and non-local block providers, the scheduler agenda can be keyed by
 * these providers. Example: on Asset Hubs (post AHM), the scheduler agenda is keyed by the relay chain block number.
 *
 * Some things to keep in mind:
 * 1. on a relay chain at block `r`, to schedule a task for execution next block, use `r + 1`
 * 2. on a parachain at block `p` and with last known relay block number `r`, to schedule a task for execution next
 *    block, use `r` - **not** `p + 1` or `r + 1`
 *    - on parachains with async backing, use `r + 2` to schedule a task for execution the block after the next,
 *      **not** `r + 2`
 */

/// -------
/// Helpers
/// -------

/**
 * Helper used in tests to origin checks on `Root`-gated scheduler extrinsics.
 *
 * @param scheduleTx The extrinsinc to be deliberately executed with a signed origin.
 * @param snapshotDescription The string used to identify the snapshot.
 */
export async function badOriginHelper<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  client: Client<TCustom, TInitStorages>,
  scheduleTx: SubmittableExtrinsic<'promise', ISubmittableResult>,
  snapshotDescription: string,
) {
  const alice = testAccounts.alice

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
  expect(dispatchError.isBadOrigin).toBe(true)
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
 * Test the process of scheduling a call with a signed (bad) origin, and check that it fails.
 *
 * 1. Sign scheduling extrinsic, and submit to chain
 * 2. Check that the extrinsic fails
 */
export async function scheduleBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const targetBlockNumber = await nextSchedulableBlockNum(client.api, testConfig.blockProvider)
  const call = client.api.tx.system.remark('test').method.toHex()
  const scheduleTx = client.api.tx.scheduler.schedule(targetBlockNumber, null, 0, call)

  await badOriginHelper(client, scheduleTx, 'events when scheduling task with insufficient origin')
}

/**
 * Test the process of scheduling a named call with a signed (bad) origin, and check that it fails.
 *
 * 1. Sign scheduling extrinsic, and submit to chain
 * 2. Check that the extrinsic fails
 */
export async function scheduleNamedBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const targetBlockNumber = await nextSchedulableBlockNum(client.api, testConfig.blockProvider)
  const call = client.api.tx.system.remark('test').method.toHex()

  const taskId = sha256AsU8a('task_id')

  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, targetBlockNumber, null, 0, call)

  await badOriginHelper(client, scheduleTx, 'events when scheduling named task with insufficient origin')
}

/**
 * Test the process of
 *
 * 1. scheduling a call with an origin fulfilling `ScheduleOrigin`
 * 2. cancelling the call with a bad origin
 * 3. checking that the cancellation call was not executed
 */
export async function cancelScheduledTaskBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const call = client.api.tx.system.remark('test').method.toHex()
  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + offset
    })
    .exhaustive()

  const scheduleTx = client.api.tx.scheduler.schedule(targetBlockNumber!, null, 0, call)

  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  const scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
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

  const cancelTx = client.api.tx.scheduler.cancel(targetBlockNumber!, 0)

  await badOriginHelper(client, cancelTx, 'events when cancelling task with insufficient origin')
}

/**
 * Test the process of
 *
 * 1. scheduling a named call with an origin fulfilling `ScheduleOrigin`
 * 2. cancelling the call with a bad origin
 */
export async function cancelNamedScheduledTaskBadOriginTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const call = client.api.tx.system.remark('test').method.toHex()
  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + offset
    })
    .exhaustive()

  const taskId = sha256AsU8a('task_id')

  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, targetBlockNumber!, null, 0, call)

  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  const scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
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
  expect(scheduled[0].unwrap().maybeId.unwrap().toU8a()).toEqual(taskId)

  const cancelTx = client.api.tx.scheduler.cancelNamed(taskId)

  await badOriginHelper(client, cancelTx, 'events when cancelling named task with insufficient origin')
}

/**
 * Test the process of
 *
 * 1. scheduling a call requiring a `Root` origin: an update to total issuance
 * 2. advancing to the scheduled block of execution
 * 3. checking that the call was executed (verify total issuance, and events)
 */
export async function scheduledCallExecutes<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + offset
    })
    .exhaustive()

  const scheduleTx = client.api.tx.scheduler.schedule(targetBlockNumber!, null, 0, adjustIssuanceTx)

  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()

  let scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()

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

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(newTotalIssuance.toBigInt()).toBe(BigInt(oldTotalIssuance.addn(1).toString()))

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(0)
}

/**
 * Test the process of
 *
 * 1. scheduling a named call requiring a `Root` origin: an update to total issuance
 * 2. advancing to the scheduled block of execution
 * 3. checking that the call was executed (verify total issuance, and events)
 */

export async function scheduledNamedCallExecutes<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const taskId = sha256AsU8a('task_id')

  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + offset
    })
    .exhaustive()
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(taskId, targetBlockNumber!, null, 0, adjustIssuanceTx)

  await scheduleInlineCallWithOrigin(
    client,
    scheduleNamedTx.method.toHex(),
    { system: 'Root' },
    testConfig.blockProvider,
  )

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  await client.dev.newBlock()

  let scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()

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

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(newTotalIssuance.toBigInt()).toBe(BigInt(oldTotalIssuance.addn(1).toString()))

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(0)
}

/**
 * Test cancellation of scheduled task
 *
 * 1. schedule a `Root`-origin call for execution sometime in the future
 * 2. cancel the call by scheduling `scheduler.cancel` to execute before the scheduled call
 * 3. verify that the original call is not executed
 * 4. verify that its data is removed from the agenda
 */
export async function cancelScheduledTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 3 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .exhaustive()

  const scheduleTx = client.api.tx.scheduler.schedule(targetBlockNumber!, null, 0, adjustIssuanceTx)

  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  let scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()

  const cancelTx = client.api.tx.scheduler.cancel(targetBlockNumber!, 0)

  await scheduleInlineCallWithOrigin(client, cancelTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  // This should capture 2 system events, and no `TotalIssuanceForced`.
  // 1. One system event will be for the test-originated dispatch injected via the helper `scheduleInlineCallWithOrigin`
  // 2. The other will be a `scheduler.Cancelled` event of the scheduled task
  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task cancellation')

  scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(0)

  await client.dev.newBlock()
}

/**
 * Test cancellation of a (named) scheduled task
 *
 * 1. schedule a `Root`-origin call for execution sometime in the future
 * 2. cancel the call by scheduling `scheduler.cancel` to execute before the scheduled call
 * 3. verify that the original call is not executed
 * 4. verify that its data is removed from the agenda
 */
export async function cancelScheduledNamedTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const taskId = sha256AsU8a('task_id')

  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 3 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .exhaustive()

  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(taskId, targetBlockNumber!, null, 0, adjustIssuanceTx)

  await scheduleInlineCallWithOrigin(
    client,
    scheduleNamedTx.method.toHex(),
    { system: 'Root' },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  let scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()

  const cancelTx = client.api.tx.scheduler.cancelNamed(taskId)

  await scheduleInlineCallWithOrigin(client, cancelTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /when|task/,
    })
    .toMatchSnapshot('events for scheduled task cancellation')

  scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(0)

  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const filteredEvents = events.filter((ev) => {
    const { event } = ev
    return (
      (event.section === 'scheduler' && event.method === 'Cancelled') ||
      (event.section === 'balances' && event.method === 'TotalIssuanceForced')
    )
  })
  expect(filteredEvents.length).toBe(0)
}

/**
 * Test scheduling a task after a delay.
 *
 * 1. schedule a delayed `Root`-origin call e.g. a fixed number of blocks after the block in which it was scheduled
 * 2. verify that the call is scheduled in the agenda at the correct block
 * 3. advance blocks to reach the execution time
 * 4. verify that the call was executed (check total issuance and events)
 * 5. verify that the call was removed from the agenda after execution
 */
export async function scheduleTaskAfterDelay<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  const offset = schedulerOffset(testConfig)
  // In case of non-local block providers, spans of blocks must be specified in terms of the nonlocal
  // provider.
  // This multiplication is because on parachains with AB, each para block spans 2 relay blocks.
  // In all other cases, the offset will just be 1, and this is idempotent.
  const delay = 3 * offset

  const scheduleTx = client.api.tx.scheduler.scheduleAfter(delay, null, 0, adjustIssuanceTx)

  let currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()
  currBlockNumber += offset

  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /when|task/,
    })
    .toMatchSnapshot('events when scheduling task with delay')

  let targetBlock: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlock = currBlockNumber + delay + 1
    })
    .with('NonLocal', () => {
      // Recall that parachains use `parachainSystem.lastRelayChainBlockNumber` to key the agenda for the next block,
      // not the agenda for the current block - a step back is needed.
      // Also, the scheduler considers the block in which call to schedule the delayed task to not count, so the
      // `+ 1` is to start counting from the next, as yet uncreated block.
      targetBlock = currBlockNumber + delay + 1 - offset
    })
    .exhaustive()

  let scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled.length).toBe(1)

  expect(scheduled[0].isSome).toBeTruthy()
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

  await client.dev.newBlock({ count: delay / offset + 1 })

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled.length).toBe(0)

  // Verify total issuance was increased
  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(newTotalIssuance.toBigInt()).toBe(BigInt(oldTotalIssuance.addn(1).toString()))
}

/**
 * Test scheduling a named task after a delay.
 *
 * 1. schedule a delayed named `Root`-origin call e.g. a fixed number of blocks after the block in which it was
 *    scheduled
 * 2. verify that the call is scheduled in the agenda at the correct block
 * 3. advance blocks to reach the execution time
 * 4. verify that the call was executed (check total issuance and events)
 * 5. verify that the call was removed from the agenda after execution
 */
export async function scheduleNamedTaskAfterDelay<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const taskId = sha256AsU8a('task_id')

  let currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

  const offset = schedulerOffset(testConfig)
  // See above note in `scheduleTaskAfterDelay`
  const delay = 5 * offset
  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamedAfter(taskId, delay, null, 0, adjustIssuanceTx)

  await scheduleInlineCallWithOrigin(
    client,
    scheduleNamedTx.method.toHex(),
    { system: 'Root' },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()
  currBlockNumber += offset

  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /when|task/,
    })
    .toMatchSnapshot('events when scheduling task with delay')

  let targetBlock: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlock = currBlockNumber + delay + 1
    })
    .with('NonLocal', () => {
      // Recall that parachains use `parachainSystem.lastRelayChainBlockNumber` to key the agenda for the next block,
      // not the agenda for the current block - a step back is needed.
      targetBlock = currBlockNumber + delay + 1 - offset
    })
    .exhaustive()

  let scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled.length).toBe(1)
  scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled[0].isSome).toBeTruthy()
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

  await client.dev.newBlock({ count: delay / offset + 1 })

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|when|task/,
    })
    .toMatchSnapshot('events for scheduled task execution')

  // Check that the call was removed from the agenda
  scheduled = await client.api.query.scheduler.agenda(currBlockNumber + delay + 1)
  expect(scheduled.length).toBe(0)

  // Verify total issuance was increased
  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(newTotalIssuance.toBigInt()).toBe(BigInt(oldTotalIssuance.addn(1).toString()))
}

/**
 * Test overweight call scheduling.
 *
 * 1. create a call requiring a `Root` origin: an update to total issuance
 * 2. artificially manipulate that call's weight to the per-block weight limit allotted to scheduled calls
 * 3. schedule the call
 * 4. check that the call was not executed
 * 5. check that it remains in the agenda for the original block it was scheduled in
 * @param chain
 *
 */
export async function scheduledOverweightCallFails<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  // Call whose weight will be artifically inflated
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  // Network's maximum allowed weight for a block's entirety of scheduled calls.
  const maxWeight = client.api.consts.scheduler.maximumWeight

  const withWeightTx = client.api.tx.utility.withWeight(adjustIssuanceTx, maxWeight)

  const offset = schedulerOffset(testConfig)
  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  // Target block is two blocks in the future - see the notes about parachain scheduling differences.
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + offset
    })
    .exhaustive()

  const scheduleTx = client.api.tx.scheduler.schedule(targetBlockNumber!, null, 0, withWeightTx)

  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  let scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)

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

  // Check that the call was not executed
  const newTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(newTotalIssuance.toBigInt()).toBe(totalIssuance.toBigInt())

  // Check that an event was emitted certifying the scheduled call as overweight

  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task/,
    })
    .toMatchSnapshot('events when scheduling overweight task')

  let events = await client.api.query.system.events()
  let overweightEvent = events.find((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'PermanentlyOverweight'
  })
  // This flag is set to `true` if an overweight event is found immediately after execution.
  // An overweight event is emitted only if the task is the first to be executed in a given block, and fails
  // execution due to being overweight.
  // If this path is taken, the test is likely running on a pre-AHM runtime, or the collectives network.
  let overweightEventFound = false
  if (overweightEvent) {
    overweightEventFound = true

    assert(client.api.events.scheduler.PermanentlyOverweight.is(overweightEvent.event))
    expect(overweightEvent.event.data.task.toJSON()).toMatchObject([targetBlockNumber!, 0])
    expect(overweightEvent.event.data.id.toJSON()).toBeNull()

    const incompleteSince = await client.api.query.scheduler.incompleteSince()
    assert(incompleteSince.isSome)
    expect(incompleteSince.unwrap().toNumber()).toBe(targetBlockNumber! + 1)
  }

  // Check that the call remains in the agenda for the original block it was scheduled in
  scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  await check(scheduled[0].unwrap()).toMatchObject(task)

  // If the overweight event is not found, even though the task was overweight, it's likely that other scheduled events
  // interfered with the agenda's scheduled tasks - even though the test clears the agenda for this block.
  // Possible cause: `voterList.ScoreUpdated` from the `on_idle` hook. Use `client.pause()` to verify.
  // IF this path is taken, the test is likely running on a post-migration asset hub runtime.
  if (!overweightEventFound) {
    let incompleteSince = await client.api.query.scheduler.incompleteSince()
    assert(incompleteSince.isSome)
    expect(incompleteSince.unwrap().toNumber()).toBe(targetBlockNumber!)

    await client.dev.newBlock()
    events = await client.api.query.system.events()

    overweightEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'PermanentlyOverweight'
    })

    expect(overweightEvent).toBeDefined()
    assert(client.api.events.scheduler.PermanentlyOverweight.is(overweightEvent!.event))
    expect(overweightEvent!.event.data.task.toJSON()).toMatchObject([targetBlockNumber!, 0])
    expect(overweightEvent!.event.data.id.toJSON()).toBeNull()

    incompleteSince = await client.api.query.scheduler.incompleteSince()
    assert(incompleteSince.isSome)
    expect(incompleteSince.unwrap().toNumber()).toBe(targetBlockNumber! + offset + 1)
  }
}

/**
 * Test scheduling of preimage lookup call.
 *
 * 1. Create a call requiring a `Root` origin: an update to total issuance
 * 2. Note the call in storage for the `preimage` pallet
 * 3. Schedule the call
 * 4. Move to the execution block
 * 5. Check that the call is executed
 *
 * Circa Mar. 2025, this failed on the Collectives chain.
 * The issue has been fixed, and when it is upstreamed, this test can then be updated.
 * @param client
 */
async function scheduleLookupCall<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const encodedProposal = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1).method
  const preimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const preImageEvents = await sendTransaction(preimageTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')

  const preimageHash = encodedProposal.hash

  await scheduleLookupCallWithOrigin(
    client,
    { hash: preimageHash, len: encodedProposal.encodedLength },
    { system: 'Root' },
    testConfig.blockProvider,
  )

  const targetBlock = await nextSchedulableBlockNum(client.api, testConfig.blockProvider)
  let agenda = await client.api.query.scheduler.agenda(targetBlock)

  expect(agenda.length).toBe(1)
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
  expect(newTotalIssuance.toBigInt()).toBe(BigInt(oldTotalIssuance.addn(1).toString()))

  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|task/,
    })
    .toMatchSnapshot('events for scheduled lookup-task execution')

  agenda = await client.api.query.scheduler.agenda(targetBlock)
  expect(agenda.length).toBe(0)
}

/**
 * Test scheduling a call using a preimage that gets removed:
 *
 * 1. Note a preimage for a call that adjusts total issuance
 * 2. Schedule the preimaged call
 * 3. Remove the preimage
 * 4. Move to execution block
 * 5. Check that the call is *not* executed
 */
export async function schedulePreimagedCall<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const encodedProposal = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1).method

  // Note the preimage
  const noteTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const noteEvents = await sendTransaction(noteTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  await checkEvents(noteEvents, 'preimage').toMatchSnapshot('note preimage events')

  // Schedule using the preimage hash
  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = schedulerOffset(testConfig)
  // Target block number is two blocks in the future: if `n` is the most recent block, the task should be executed
  // at `n + 2`.
  let targetBlockNumber: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlockNumber = initialBlockNumber + 2 * offset
    })
    .with('NonLocal', () => {
      targetBlockNumber = initialBlockNumber + offset
    })
    .exhaustive()

  await client.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [targetBlockNumber!],
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

  let scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
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
  await unnoteTx.signAndSend(testAccounts.alice)
  await client.dev.newBlock()

  const oldTotalIssuance = await client.api.query.balances.totalIssuance()

  // Move to execution block
  await client.dev.newBlock()

  scheduled = await client.api.query.scheduler.agenda(targetBlockNumber!)

  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
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
  expect(newTotalIssuance.toBigInt()).toBe(oldTotalIssuance.toBigInt())

  const events = await client.api.query.system.events()
  const balanceEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'TotalIssuanceForced'
  })
  expect(balanceEvents.length).toBe(0)

  const [schedEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'scheduler' && event.method === 'CallUnavailable'
  })
  assert(client.api.events.scheduler.CallUnavailable.is(schedEvent.event))
  expect(schedEvent.event.data.task.toJSON()).toMatchObject([targetBlockNumber!, 0])
  expect(schedEvent.event.data.id.toJSON()).toBeNull()
}

/**
 * Helper function containing common logic for testing periodic tasks - can be used to test both anonymous and named
 * periodic tasks.
 *
 * The periodic task starts with a delay - for now, it is hardcoded to be 2.
 *
 * It tests that periodic tasks execute at the correct intervals, for the expected number of executions, and that
 * the task is removed from the agenda after all executions, no longer to be rescheduled.
 *
 * Rough process:
 * 1. manually schedule the periodic task to run in the next block
 * 2. move to block just before the first execution
 * 3. check the agenda to observe proper structure of the periodic task
 * 4. run through each of the task's repetitions, checking that
 *
 *     4.1. the period between executions is correct
 *
 *     4.2. the task is indeed executed correctly
 *
 *     4.3. while there are still repetitions left, that the task reschedules itself with the correct new number of
 * repetitions
 *
 *     4.4. that on the last repetition, the task no longer reschedules itself
 *
 * 5. at the end, verify that exactly the expected number of executions have occurred, and that
 * 6. the task is removed from the agenda.
 *
 * @param scheduleTx The extrinsic containing the periodic task (named or otherwise) to be scheduled.
 * @param taskId The ID of the periodic task, if named. Null otherwise.
 * @param period The period of the task - on parachains, with nonlocal block providers, it must be expressed by how
 *        many relay blocks it spans.
 * @param testConfig The test configuration - needed to account for relaychain vs parachain scheduler agenda keying.
 */
async function testPeriodicTask<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  scheduleTx: SubmittableExtrinsic<'promise', ISubmittableResult>,
  taskId: Uint8Array | null,
  period: number,
  testConfig: TestConfig,
) {
  const [client] = await setupNetworks(chain)

  const offset = schedulerOffset(testConfig)

  // Manually schedule `scheduleTx` to run on the next block.
  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  const initialTotalIssuance = await client.api.query.balances.totalIssuance()
  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)

  let currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

  // Move to just before the first execution block
  await client.dev.newBlock()
  currBlockNumber += offset

  // Agenda check for the first scheduled execution
  let targetBlock: number
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlock = currBlockNumber + offset
    })
    .with('NonLocal', () => {
      // Recall that on a parachain, a task to be run on the next block has an agenda key of
      // `parachainSystem.lastRelayChainBlockNumber`, which `getBlockNumber` will return.
      targetBlock = currBlockNumber
    })
    .exhaustive()
  let agenda = await client.api.query.scheduler.agenda(targetBlock!)

  expect(agenda.length).toBe(1)
  expect(agenda[0].isSome).toBeTruthy()
  await check(agenda[0].unwrap()).toMatchObject({
    maybeId: taskId ? `0x${Buffer.from(taskId).toString('hex')}` : null,
    priority: 0,
    call: { inline: adjustIssuanceTx.method.toHex() },
    // The last repetition will have this as null, so in effect, this ranges from `REPETITIONS - 1` to `null`,
    // for a total of `REPETITIONS`.
    maybePeriodic: [period, REPETITIONS - 1],
    origin: {
      system: {
        root: null,
      },
    },
  })

  // Run through the task's repetitions, and verify that
  // 1. it executes at the correct intervals,
  // 2. it runs the expected number of executions.
  // 3. on the last repetition, the task no longer reschedules itself.
  for (let i = 1; i <= REPETITIONS; i++) {
    // Execution block
    await client.dev.newBlock()
    currBlockNumber += offset

    await checkSystemEvents(client, 'scheduler', {
      section: 'balances',
      method: 'TotalIssuanceForced',
    })
      .redact({
        redactKeys: /new|old|task|when/,
      })
      .toMatchSnapshot(`events for ${taskId ? 'named' : ''} periodic task execution ${i}`)

    const currentTotalIssuance = await client.api.query.balances.totalIssuance()
    expect(currentTotalIssuance.toBigInt()).toBe(BigInt(initialTotalIssuance.addn(i).toString()))

    // Check agenda for next scheduled execution (if not the last iteration)
    if (i < REPETITIONS) {
      if (testConfig.blockProvider === 'Local') {
        targetBlock = currBlockNumber + period
      } else {
        targetBlock = currBlockNumber + period - offset
      }
      agenda = await client.api.query.scheduler.agenda(targetBlock!)

      expect(agenda.length).toBe(1)
      expect(agenda[0].isSome).toBeTruthy()

      let maybePeriodic: [number, number] | null
      // Recall that the first execution had `REPETITIONS - 1` in this field, when `i` was 1 i.e. first iteration.
      // Therefore, when `i` is `REPETITIONS - 1`, it will be ran one last time - no more repetitions to be scheduled,
      // and this field of the periodic task structure must be `null`.
      if (i === REPETITIONS - 1) {
        maybePeriodic = null
      } else {
        maybePeriodic = [period, REPETITIONS - (i + 1)]
      }

      await check(agenda[0].unwrap()).toMatchObject({
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

    await client.dev.newBlock()
    currBlockNumber += offset
  }

  // Verify task is removed after all executions
  match(testConfig.blockProvider)
    .with('Local', () => {
      targetBlock = currBlockNumber + offset
    })
    .with('NonLocal', () => {
      targetBlock = currBlockNumber
    })
    .exhaustive()
  agenda = await client.api.query.scheduler.agenda(targetBlock!)
  expect(agenda.length).toBe(0)

  // Check final issuance - must have been increased by `REPETITIONS * increment == REPETITIONS`.
  const finalTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(finalTotalIssuance.toBigInt()).toBe(BigInt(initialTotalIssuance.addn(REPETITIONS).toString()))
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

  const offset = schedulerOffset(testConfig)
  const delay = match(testConfig.blockProvider)
    .with('Local', () => 2 * offset)
    // Parachain scheduling differences - see notes above.
    // This is obviously 2, but leaving it like this clarifies what's happening.
    .with('NonLocal', () => 2 * offset - offset)
    .exhaustive()

  const period = PERIOD * offset

  const scheduleTx = client.api.tx.scheduler.schedule(
    currBlockNumber + delay, // when
    [period, REPETITIONS], // maybe_periodic: [period, repetitions]
    0, // priority
    adjustIssuanceTx, // call
  )

  await testPeriodicTask(chain, scheduleTx, null, period, testConfig)
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const adjustIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance('Increase', 1)
  const taskId = sha256AsU8a('task_id')
  const currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

  const offset = schedulerOffset(testConfig)
  const delay = match(testConfig.blockProvider)
    .with('Local', () => 2 * offset)
    // Recall: to schedule a task on the next block of a parachain, the offset is 0. On the block after that one,
    // it is 1 if async backing is disabled, 2 if enabled.
    .with('NonLocal', () => 2 * offset - offset)
    .exhaustive()

  const period = PERIOD * offset

  const scheduleNamedTx = client.api.tx.scheduler.scheduleNamed(
    taskId, // id
    currBlockNumber + delay, // when
    [period, REPETITIONS], // maybe_periodic: [period, repetitions]
    0, // priority
    adjustIssuanceTx, // call
  )

  await testPeriodicTask(chain, scheduleNamedTx, taskId, period, testConfig)
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
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

  const initBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  let currBlockNumber = initBlockNumber
  const offset = schedulerOffset(testConfig)
  let priorityTargetBlock: number
  match(testConfig.blockProvider)
    .with('Local', async () => {
      priorityTargetBlock = initBlockNumber + 2 * offset
    })
    .with('NonLocal', async () => {
      priorityTargetBlock = initBlockNumber + offset
    })
    .exhaustive()

  // Schedule both tasks for the same block with different priorities
  const scheduleHighPriorityTx = client.api.tx.scheduler.schedule(
    priorityTargetBlock!,
    null,
    0, // higher priority
    highPriorityTx,
  )
  const scheduleLowPriorityTx = client.api.tx.scheduler.schedule(
    priorityTargetBlock!,
    null,
    1, // lower priority
    lowPriorityTx,
  )

  const targetBlock = await nextSchedulableBlockNum(client.api, testConfig.blockProvider)

  // Schedule both tasks
  await client.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [targetBlock],
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
  currBlockNumber += offset

  const manuallyScheduledBlock = await nextSchedulableBlockNum(client.api, testConfig.blockProvider)

  // Verify both tasks are in the agenda
  let scheduled = await client.api.query.scheduler.agenda(manuallyScheduledBlock)
  expect(scheduled.length).toBe(2)
  expect(scheduled[0].isSome).toBeTruthy()
  expect(scheduled[1].isSome).toBeTruthy()

  // Execute first block - should only complete high priority task
  await client.dev.newBlock()
  currBlockNumber += offset

  // Check events - there should only be one execution
  await checkSystemEvents(client, 'scheduler', { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({
      redactKeys: /new|old|task|when/,
    })
    .toMatchSnapshot('events for priority weighted tasks execution')

  // Check that *only* the high priority task executed
  const midTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(midTotalIssuance.toBigInt()).toBe(BigInt(initialTotalIssuance.addn(2).toString()))

  // Verify `incompleteSince` is set to current block
  const incompleteSince = await client.api.query.scheduler.incompleteSince()
  assert(incompleteSince.isSome)
  match(testConfig.blockProvider)
    .with('Local', async () => {
      expect(incompleteSince.unwrap().toNumber()).toBe(currBlockNumber)
    })
    .with('NonLocal', async () => {
      expect(incompleteSince.unwrap().toNumber()).toBe(currBlockNumber - offset)
    })
    .exhaustive()

  // Check the agenda for the most recently built block
  match(testConfig.blockProvider)
    .with('Local', async () => {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
    })
    .with('NonLocal', async () => {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber - offset)
    })
    .exhaustive()

  expect(scheduled.length).toBe(2)
  // Expect that both tasks are `Some`
  expect(scheduled.every((task) => task.isSome)).toBeTruthy()
  // Disambiguate between the two tasks
  const lowPriorityTask = scheduled.find((task) => task.unwrap().priority.toNumber() === 1)
  const highPriorityTask = scheduled.find((task) => task.unwrap().priority.toNumber() === 0)

  expect(lowPriorityTask).toBeDefined()
  await check(lowPriorityTask).toMatchObject({
    maybeId: null,
    priority: 1,
    call: { inline: lowPriorityTx.method.toHex() },
    maybePeriodic: null,
    origin: { system: { root: null } },
  })

  expect(highPriorityTask).toBeDefined()
  await check(highPriorityTask).toMatchObject({
    maybeId: null,
    priority: 0,
    call: { inline: highPriorityTx.method.toHex() },
    maybePeriodic: null,
    origin: { system: { root: null } },
  })

  // Move to the next block, where the lower priority task will execute
  await client.dev.newBlock()
  currBlockNumber += offset

  const finalTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(finalTotalIssuance.toBigInt()).toBe(BigInt(initialTotalIssuance.addn(3).toString()))

  // Verify `incompleteSince` has been unset
  const finalIncompleteSince = await client.api.query.scheduler.incompleteSince()
  // The behavior of the scheduler pallet going forward is now such that it always sets `incompleteSince` to `n + 1`,
  // where `n` is the block in which the agenda was last serviced.
  // `currBlockNumber` advanced by `offset` in the meantime, so `- 1` is the correct value.
  expect(finalIncompleteSince.isSome).toBeTruthy()
  match(testConfig.blockProvider)
    .with('Local', async () => {
      expect(finalIncompleteSince.unwrap().toNumber()).toBe(currBlockNumber + 1)
    })
    .with('NonLocal', async () => {
      expect(finalIncompleteSince.unwrap().toNumber()).toBe(currBlockNumber - 1)
    })
    .exhaustive()

  // Check that the agenda for the block in which the 2 priority tasks were scheduled is empty
  scheduled = await client.api.query.scheduler.agenda(priorityTargetBlock!)
  expect(scheduled.length).toBe(0)

  // The agenda on the block just before the most recently built block should be emoty
  match(testConfig.blockProvider)
    .with('Local', async () => {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 1)
    })
    .with('NonLocal', async () => {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber - 2 * offset)
    })
    .exhaustive()

  expect(scheduled.length).toBe(0)

  // Check the agenda on the most recently built block - should be empty
  match(testConfig.blockProvider)
    .with('Local', async () => {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber)
    })
    .with('NonLocal', async () => {
      scheduled = await client.api.query.scheduler.agenda(currBlockNumber - offset)
    })
    .exhaustive()
  expect(scheduled.length).toBe(0)
}

/**
 * Test setting and canceling retry configuration for unnamed scheduled tasks:
 *
 * 1. Create and schedule a task that will fail
 *    - `remarkWithEvent` with `Root` origin, which will fail
 * 2. Set the retry configuration of this scheduled task using `scheduler.setRetry`
 * 3. Verify the task fails and is rescheduled per its retry config
 * 4. Cancel the retry configuration
 * 5. Verify the task remains scheduled but without its retry config
 */
export async function scheduleWithRetryConfig<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  // Create a task that will fail - remarkWithEvent requires signed origin
  const failingTx = client.api.tx.system.remarkWithEvent('will_fail')
  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

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

  const offset = schedulerOffset(testConfig)

  const period = 3 * offset

  const retryConfig = {
    totalRetries: 3,
    remaining: 3,
    period,
  }

  let targetBlock: number
  match(testConfig.blockProvider)
    .with('Local', async () => {
      targetBlock = initialBlockNumber + 3 * offset
    })
    .with('NonLocal', async () => {
      // Recall that on a parachain, the current value of `parachainSystem.lastRelayChainBlockNumber`
      // keys the agenda for the next block, not the current one, so a step back is needed.
      targetBlock = initialBlockNumber + 3 * offset - offset
    })
    .exhaustive()

  // Schedule the named task first
  const scheduleTx = client.api.tx.scheduler.schedule(targetBlock!, null, 1, failingTx)
  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  // Move to scheduling block
  await client.dev.newBlock()

  // Check initial schedule
  let scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  await check(scheduled[0].unwrap()).toMatchObject(baseTask)

  // Set retry configuration
  const setRetryTx = client.api.tx.scheduler.setRetry([targetBlock!, 0], retryConfig.totalRetries, retryConfig.period)
  await scheduleInlineCallWithOrigin(client, setRetryTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  let retryOpt = await client.api.query.scheduler.retries([targetBlock!, 0])
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
    .toMatchSnapshot('events for failed anonymous task execution')

  const rescheduledBlock = targetBlock! + period
  // Verify task failed and was rescheduled
  scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled.length).toBe(0)
  scheduled = await client.api.query.scheduler.agenda(rescheduledBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })

  retryOpt = await client.api.query.scheduler.retries([rescheduledBlock!, 0])
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 1,
  })

  const cancelRetryTx = client.api.tx.scheduler.cancelRetry([rescheduledBlock!, 0])
  await scheduleInlineCallWithOrigin(client, cancelRetryTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  // Check retry cancellation events
  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task/,
    })
    .toMatchSnapshot('events for retry config cancellation')

  await client.dev.newBlock()

  // Verify task is still scheduled but without retry config
  scheduled = await client.api.query.scheduler.agenda(rescheduledBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })

  retryOpt = await client.api.query.scheduler.retries([rescheduledBlock!, 0])
  expect(retryOpt.isNone).toBeTruthy()
}

/**
 * Test setting and canceling retry configuration for named scheduled tasks:
 *
 * 1. Create and schedule a named task that will fail
 *    - `remarkWithEvent` fails with `Root` origin
 * 2. Set retry configuration using `scheduler.setRetryNamed`
 * 3. Verify task fails and is rescheduled per its retry config
 * 4. Cancel the retry configuration with `cancelRetryNamed`
 * 5. Verify the task remains scheduled with its retry config
 *     - retries of named tasks have no id, and must thus be cancelled with `cancelRetry`
 * 6. Cancel the retry configuration with `cancelRetry`
 * 7. Verify the task remains scheduled but without its retry config
 */
export async function scheduleNamedWithRetryConfig<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  // Create a task that will fail - remarkWithEvent requires signed origin
  const failingTx = client.api.tx.system.remarkWithEvent('will_fail')
  const taskId = sha256AsU8a('retry_task')
  const initialBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

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

  const offset = schedulerOffset(testConfig)

  const period = 3 * offset

  const retryConfig = {
    totalRetries: 3,
    remaining: 3,
    period,
  }

  let targetBlock: number
  match(testConfig.blockProvider)
    .with('Local', async () => {
      targetBlock = initialBlockNumber + 3 * offset
    })
    .with('NonLocal', async () => {
      // Recall that on a parachain, the current value of `parachainSystem.lastRelayChainBlockNumber`
      // keys the agenda for the next block, not the current one, so a step back is needed.
      targetBlock = initialBlockNumber + 3 * offset - offset
    })
    .exhaustive()

  // Schedule the named task first
  const scheduleTx = client.api.tx.scheduler.scheduleNamed(taskId, targetBlock!, null, 1, failingTx)
  await scheduleInlineCallWithOrigin(client, scheduleTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  // Move to scheduling block
  await client.dev.newBlock()

  // Check initial schedule
  let scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  await check(scheduled[0].unwrap()).toMatchObject(baseTask)

  // Set retry configuration
  const setRetryTx = client.api.tx.scheduler.setRetryNamed(taskId, retryConfig.totalRetries, retryConfig.period)
  await scheduleInlineCallWithOrigin(client, setRetryTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  let retryOpt = await client.api.query.scheduler.retries([targetBlock!, 0])
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

  const rescheduledBlock = targetBlock! + period
  // Verify task failed and was rescheduled
  scheduled = await client.api.query.scheduler.agenda(targetBlock!)
  expect(scheduled.length).toBe(0)
  scheduled = await client.api.query.scheduler.agenda(rescheduledBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  // Retries of named tasks have no id
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })

  retryOpt = await client.api.query.scheduler.retries([rescheduledBlock!, 0])
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 1,
  })

  let cancelRetryTx = client.api.tx.scheduler.cancelRetryNamed(taskId)
  await scheduleInlineCallWithOrigin(client, cancelRetryTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  // Check retry cancellation events
  await checkSystemEvents(client, 'scheduler')
    .redact({
      redactKeys: /task/,
    })
    .toMatchSnapshot('events for retry config cancellation')

  await client.dev.newBlock()

  // Verify task is still scheduled...
  scheduled = await client.api.query.scheduler.agenda(rescheduledBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  // Once again - retries of named tasks have no id
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })

  //  ... *with* a retry config
  retryOpt = await client.api.query.scheduler.retries([rescheduledBlock!, 0])
  // A named task's retry will be unnamed, so its retry configuration must be cancelled
  // via `cancelRetry` - `cancelRetryNamed` has no effect.
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 1,
  })

  await client.dev.newBlock()

  const finalRescheduledBlock = rescheduledBlock! + period

  // In the meantime, the task has been retried a second time, and has scheduled for a third
  scheduled = await client.api.query.scheduler.agenda(finalRescheduledBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })
  retryOpt = await client.api.query.scheduler.retries([finalRescheduledBlock!, 0])
  assert(retryOpt.isSome)
  retry = retryOpt.unwrap()
  await check(retry).toMatchObject({
    ...retryConfig,
    remaining: retryConfig.remaining - 2,
  })

  // Cancel the retry configuration with `cancelRetry`
  cancelRetryTx = client.api.tx.scheduler.cancelRetry([finalRescheduledBlock!, 0])
  await scheduleInlineCallWithOrigin(client, cancelRetryTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock()

  retryOpt = await client.api.query.scheduler.retries([finalRescheduledBlock!, 0])
  expect(retryOpt.isNone).toBeTruthy()

  // Check that the retry config cancellation does not affect the scheduled third try
  scheduled = await client.api.query.scheduler.agenda(finalRescheduledBlock!)
  expect(scheduled.length).toBe(1)
  expect(scheduled[0].isSome).toBeTruthy()
  await check(scheduled[0].unwrap()).toMatchObject({
    ...baseTask,
    maybeId: null,
  })
}

export function baseSchedulerE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'scheduling a call is possible, and the call itself succeeds',
        testFn: async () => await scheduledCallExecutes(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'scheduling a named call is possible, and the call itself succeeds',
        testFn: async () => await scheduledNamedCallExecutes(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'cancelling a scheduled task is possible',
        testFn: async () => await cancelScheduledTask(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'cancelling a named scheduled task is possible',
        testFn: async () => await cancelScheduledNamedTask(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'scheduling a task after a delay is possible',
        testFn: async () => await scheduleTaskAfterDelay(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'scheduling a periodic task is possible',
        testFn: async () => await schedulePeriodicTask(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'scheduling a named periodic is possible',
        testFn: async () => await scheduleNamedPeriodicTask(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'scheduling a named task after a delay is possible',
        testFn: async () => await scheduleNamedTaskAfterDelay(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'execution of scheduled preimage lookup call works',
        testFn: async () => await scheduleLookupCall(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'priority-based execution of weighted tasks works correctly',
        testFn: async () => await schedulePriorityWeightedTasks(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'schedule task with wrong origin',
        testFn: async () => await scheduleBadOriginTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'schedule named task with wrong origin',
        testFn: async () => await scheduleNamedBadOriginTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'cancel scheduled task with wrong origin',
        testFn: async () => await cancelScheduledTaskBadOriginTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'cancel named scheduled task with wrong origin',
        testFn: async () => await cancelNamedScheduledTaskBadOriginTest(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'scheduling an overweight call is possible, but the call itself fails',
        testFn: async () => await scheduledOverweightCallFails(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'scheduling a call using a preimage that gets removed',
        testFn: async () => await schedulePreimagedCall(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'setting and canceling retry configuration for unnamed scheduled tasks',
        testFn: async () => await scheduleWithRetryConfig(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'setting and canceling retry configuration for named scheduled tasks',
        testFn: async () => await scheduleNamedWithRetryConfig(chain, testConfig),
      },
    ],
  }
}
