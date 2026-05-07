import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'

import type { ApiPromise } from '@polkadot/api'
import type { EventRecord } from '@polkadot/types/interfaces'
import type { Codec } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkEvents, getBlockNumber, sortAddressesByBytes, type TestConfig } from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

type TxResult = { events: Promise<Codec[]> }
type EventSource = TxResult | EventRecord[]

const UNIT = 1_000_000_000_000n
const INHERITANCE_DELAY = 2
const CANCEL_DELAY = 2

type RecoveryGroupConfig = {
  friends: string[]
  friendsNeeded: number
  inheritor: string
  inheritanceDelay?: number
  inheritancePriority: number
  cancelDelay?: number
}

function normalizeAddress<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, address: string) {
  return encodeAddress(address, chain.properties.addressEncoding)
}

function buildGroup<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, config: RecoveryGroupConfig) {
  return {
    friends: sortAddressesByBytes(config.friends, chain.properties.addressEncoding),
    friendsNeeded: config.friendsNeeded,
    inheritor: config.inheritor,
    inheritanceDelay: config.inheritanceDelay ?? INHERITANCE_DELAY,
    inheritancePriority: config.inheritancePriority,
    cancelDelay: config.cancelDelay ?? CANCEL_DELAY,
  }
}

async function setupRecoveryNetwork<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  return client
}

async function getAccount(client: { api: ApiPromise }, address: string) {
  return await client.api.query.system.account(address)
}

async function getFreeBalance(client: { api: ApiPromise }, address: string): Promise<bigint> {
  return (await getAccount(client, address)).data.free.toBigInt()
}

async function getProvidedBlockNumber<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, chain: Chain<TCustom, TInitStorages>): Promise<number> {
  return await getBlockNumber(client.api, chain.properties.schedulerBlockProvider)
}

async function advanceUntilAtLeast<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, chain: Chain<TCustom, TInitStorages>, target: number) {
  let current = await getProvidedBlockNumber(client, chain)
  let iterations = 0

  while (current < target) {
    await client.dev.newBlock()
    current = await getProvidedBlockNumber(client, chain)
    iterations += 1
    expect(iterations, `provided block number did not reach target ${target}`).toBeLessThanOrEqual(10)
  }

  return { current, iterations }
}

async function getAttempt(client: { api: ApiPromise }, lost: string, friendGroupIndex: number) {
  const attempt = await (client.api.query.recovery as any).attempt(lost, friendGroupIndex)
  return attempt.isSome ? attempt.unwrap() : null
}

async function getAttemptState(client: { api: ApiPromise }, lost: string, friendGroupIndex: number) {
  const attempt = await getAttempt(client, lost, friendGroupIndex)
  if (!attempt) {
    return null
  }

  const state = attempt[0]

  return {
    initiator: state.initiator.toString(),
    initBlock: state.initBlock.toNumber(),
    lastApprovalBlock: state.lastApprovalBlock.toNumber(),
    approvals: state.approvals,
  }
}

async function getInheritorState(client: { api: ApiPromise }, lost: string) {
  const inheritor = await (client.api.query.recovery as any).inheritor(lost)
  if (inheritor.isNone) {
    return null
  }

  const tuple = inheritor.unwrap()

  return {
    order: tuple[0].toNumber(),
    inheritor: tuple[1].toString(),
  }
}

async function getEventRecords(resultOrEvents: EventSource): Promise<EventRecord[]> {
  const raw = Array.isArray(resultOrEvents) ? resultOrEvents : await (resultOrEvents as TxResult).events
  return raw as unknown as EventRecord[]
}

async function findEvent(resultOrEvents: EventSource, predicate: (event: any) => boolean, message: string) {
  const events = await getEventRecords(resultOrEvents)
  const event = events.find(({ event }) => predicate(event))
  expect(event, message).toBeDefined()
  return event!
}

/**
 * Extract named fields from pallet-recovery event data.
 *
 * pallet-recovery has no generated TypeScript types in @polkadot/api yet.
 * All event data field accesses are funnelled through this helper to contain
 * the necessary cast to a single site.
 */
function recoveryEventData(event: EventRecord): Record<string, any> {
  return event.event.data as unknown as Record<string, any>
}

async function expectModuleError(
  client: { api: ApiPromise },
  resultOrEvents: EventSource,
  matcher: (moduleError: any) => boolean,
  message: string,
) {
  const failed = await findEvent(resultOrEvents, (event) => client.api.events.system.ExtrinsicFailed.is(event), message)
  assert(client.api.events.system.ExtrinsicFailed.is(failed.event))
  const dispatchError = failed.event.data.dispatchError
  assert(dispatchError.isModule, 'Expected module error')
  expect(matcher(dispatchError.asModule), message).toBe(true)
}

async function expectProxyExecuted(client: { api: ApiPromise }, resultOrEvents: EventSource) {
  const proxyExecuted = await findEvent(
    resultOrEvents,
    (event) => client.api.events.proxy.ProxyExecuted.is(event),
    'Expected proxy execution event',
  )
  assert(client.api.events.proxy.ProxyExecuted.is(proxyExecuted.event))
  return proxyExecuted.event.data
}

async function configureSingleGroup<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, chain: Chain<TCustom, TInitStorages>, group: RecoveryGroupConfig) {
  const tx = client.api.tx.recovery.setFriendGroups([buildGroup(chain, group)])
  const events = await sendTransaction(tx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  return events
}

async function configureGroups<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, chain: Chain<TCustom, TInitStorages>, groups: RecoveryGroupConfig[]) {
  const tx = client.api.tx.recovery.setFriendGroups(groups.map((group) => buildGroup(chain, group)))
  const events = await sendTransaction(tx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  return events
}

async function completeRecovery<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  client: Client<TCustom, TInitStorages>,
  chain: Chain<TCustom, TInitStorages>,
  friendGroupIndex: number,
  approvers: (typeof testAccounts.bob)[],
) {
  const lost = testAccounts.alice.address
  const initiator = approvers[0]

  await sendTransaction(client.api.tx.recovery.initiateAttempt(lost, friendGroupIndex).signAsync(initiator))
  await client.dev.newBlock()

  for (const approver of approvers) {
    await sendTransaction(client.api.tx.recovery.approveAttempt(lost, friendGroupIndex).signAsync(approver))
    await client.dev.newBlock()
  }

  const attempt = await getAttemptState(client, lost, friendGroupIndex)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, chain, attempt!.initBlock + INHERITANCE_DELAY)

  const finishEvents = await sendTransaction(
    client.api.tx.recovery.finishAttempt(lost, friendGroupIndex).signAsync(initiator),
  )
  await client.dev.newBlock()
  return finishEvents
}

async function fullLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  const setGroupEvents = await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await checkEvents(setGroupEvents, 'recovery').toMatchSnapshot('events when Alice sets friend groups')

  const initiateEvents = await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await checkEvents(initiateEvents, 'recovery').toMatchSnapshot('events when Bob initiates recovery attempt')

  const initiated = await findEvent(
    initiateEvents,
    (event) => client.api.events.recovery.AttemptInitiated.is(event),
    'Expected AttemptInitiated event',
  )
  assert(client.api.events.recovery.AttemptInitiated.is(initiated.event))
  expect(recoveryEventData(initiated).lost.toString()).toBe(normalizeAddress(chain, alice.address))
  expect(recoveryEventData(initiated).initiator.toString()).toBe(normalizeAddress(chain, bob.address))
  expect(recoveryEventData(initiated).friendGroupIndex.toNumber()).toBe(0)

  const approveByBobEvents = await sendTransaction(
    client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await checkEvents(approveByBobEvents, 'recovery').toMatchSnapshot('events when Bob approves recovery attempt')

  const approveByCharlieEvents = await sendTransaction(
    client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie),
  )
  await client.dev.newBlock()
  await checkEvents(approveByCharlieEvents, 'recovery').toMatchSnapshot('events when Charlie approves recovery attempt')

  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, chain, attempt!.initBlock + INHERITANCE_DELAY)

  const finishEvents = await sendTransaction(client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await checkEvents(finishEvents, 'recovery').toMatchSnapshot('events when Bob finishes recovery attempt')

  const finished = await findEvent(
    finishEvents,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected AttemptFinished event',
  )
  assert(client.api.events.recovery.AttemptFinished.is(finished.event))
  expect(recoveryEventData(finished).previousInheritor.isNone).toBe(true)
  expect(recoveryEventData(finished).inheritor.toString()).toBe(normalizeAddress(chain, eve.address))
  const inheritor = await getInheritorState(client, alice.address)
  expect(inheritor).not.toBeNull()
  expect(inheritor!.order).toBe(0)
  expect(inheritor!.inheritor).toBe(normalizeAddress(chain, eve.address))

  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const controlCall = client.api.tx.balances.transferKeepAlive(ferdie.address, 10n * UNIT)
  const controlEvents = await sendTransaction(
    client.api.tx.recovery.controlInheritedAccount(alice.address, controlCall).signAsync(eve),
  )
  await client.dev.newBlock()
  await checkEvents(controlEvents, 'recovery', { section: 'balances', method: 'Transfer' }).toMatchSnapshot(
    'events when Eve controls recovered account',
  )

  const controlled = await findEvent(
    controlEvents,
    (event) => client.api.events.recovery.RecoveredAccountControlled.is(event),
    'Expected RecoveredAccountControlled event',
  )
  assert(client.api.events.recovery.RecoveredAccountControlled.is(controlled.event))
  expect(recoveryEventData(controlled).callResult.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + 10n * UNIT)
}

async function initiatorCancelsAfterDelayTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: testAccounts.eve.address,
    inheritancePriority: 0,
    cancelDelay: CANCEL_DELAY,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, chain, attempt!.lastApprovalBlock + CANCEL_DELAY)

  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const canceled = await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled event',
  )
  assert(client.api.events.recovery.AttemptCanceled.is(canceled.event))
  expect(recoveryEventData(canceled).canceler.toString()).toBe(normalizeAddress(chain, bob.address))
  expect(await getAttempt(client, alice.address, 0)).toBeNull()
}

async function lostAccountCancelsImmediatelyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 4,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(alice))
  await client.dev.newBlock()

  const canceled = await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled event',
  )
  assert(client.api.events.recovery.AttemptCanceled.is(canceled.event))
  expect(recoveryEventData(canceled).canceler.toString()).toBe(normalizeAddress(chain, alice.address))
  expect(await getAttempt(client, alice.address, 0)).toBeNull()
}

async function lostAccountSlashesAttemptTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts
  const bobFreeBefore = await getFreeBalance(client, bob.address)

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const slashEvents = await sendTransaction(client.api.tx.recovery.slashAttempt(0).signAsync(alice))
  await client.dev.newBlock()

  await findEvent(
    slashEvents,
    (event) => client.api.events.recovery.AttemptSlashed.is(event),
    'Expected AttemptSlashed event',
  )
  expect(await getAttempt(client, alice.address, 0)).toBeNull()
  expect(await getFreeBalance(client, bob.address)).toBeLessThan(bobFreeBefore)
}

async function approvalResetsTimerTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, dave, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 20,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const initialAttempt = await getAttemptState(client, alice.address, 0)
  expect(initialAttempt).not.toBeNull()
  await advanceUntilAtLeast(client, chain, initialAttempt!.lastApprovalBlock + 2)

  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  const approvedAttempt = await getAttemptState(client, alice.address, 0)
  expect(approvedAttempt).not.toBeNull()

  const failedCancelEvents = await sendTransaction(
    client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedCancelEvents,
    (moduleError) => client.api.errors.recovery.NotYetCancelable.is(moduleError),
    'Expected NotYetCancelable after approval reset the timer',
  )

  await advanceUntilAtLeast(client, chain, approvedAttempt!.lastApprovalBlock + 20)
  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled event',
  )
}

async function inheritanceOrderConflictTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  await configureGroups(client, chain, [
    { friends: [bob.address, charlie.address], friendsNeeded: 2, inheritor: eve.address, inheritancePriority: 1 },
    { friends: [dave.address, ferdie.address], friendsNeeded: 2, inheritor: ferdie.address, inheritancePriority: 2 },
    { friends: [charlie.address, dave.address], friendsNeeded: 2, inheritor: bob.address, inheritancePriority: 0 },
  ])

  for (const [groupIdx, [initiator, approver]] of [
    [0, [bob, charlie]],
    [1, [dave, ferdie]],
    [2, [charlie, dave]],
  ] as const) {
    await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, groupIdx).signAsync(initiator))
    await client.dev.newBlock()
    await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, groupIdx).signAsync(initiator))
    await client.dev.newBlock()
    await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, groupIdx).signAsync(approver))
    await client.dev.newBlock()
  }

  const latestAttempt = await getAttemptState(client, alice.address, 2)
  expect(latestAttempt).not.toBeNull()
  await advanceUntilAtLeast(client, chain, latestAttempt!.initBlock + INHERITANCE_DELAY)

  const finishOrder1Events = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  const firstFinished = await findEvent(
    finishOrder1Events,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected first AttemptFinished event',
  )
  assert(client.api.events.recovery.AttemptFinished.is(firstFinished.event))
  expect(recoveryEventData(firstFinished).previousInheritor.isNone).toBe(true)
  expect(recoveryEventData(firstFinished).inheritor.toString()).toBe(normalizeAddress(chain, eve.address))
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(chain, eve.address))

  const finishOrder2Events = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 1).signAsync(dave),
  )
  await client.dev.newBlock()
  const discarded = await findEvent(
    finishOrder2Events,
    (event) => client.api.events.recovery.AttemptDiscarded.is(event),
    'Expected AttemptDiscarded event',
  )
  assert(client.api.events.recovery.AttemptDiscarded.is(discarded.event))
  expect(recoveryEventData(discarded).existingInheritor.toString()).toBe(normalizeAddress(chain, eve.address))
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(chain, eve.address))

  const finishOrder0Events = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 2).signAsync(charlie),
  )
  await client.dev.newBlock()
  const displaced = await findEvent(
    finishOrder0Events,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected displacement AttemptFinished event',
  )
  assert(client.api.events.recovery.AttemptFinished.is(displaced.event))
  expect(recoveryEventData(displaced).previousInheritor.isSome).toBe(true)
  expect(recoveryEventData(displaced).previousInheritor.unwrap().toString()).toBe(normalizeAddress(chain, eve.address))
  expect(recoveryEventData(displaced).inheritor.toString()).toBe(normalizeAddress(chain, bob.address))
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(chain, bob.address))
}

async function revokeInheritorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, chain, 0, [bob, charlie])

  const revokeEvents = await sendTransaction(client.api.tx.recovery.revokeInheritor().signAsync(alice))
  await client.dev.newBlock()

  await findEvent(
    revokeEvents,
    (event) => client.api.events.recovery.InheritorRevoked.is(event),
    'Expected InheritorRevoked event',
  )
  expect(await getInheritorState(client, alice.address)).toBeNull()

  const failedControlEvents = await sendTransaction(
    client.api.tx.recovery
      .controlInheritedAccount(alice.address, client.api.tx.system.remark('after revoke'))
      .signAsync(eve),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedControlEvents,
    (moduleError) => client.api.errors.recovery.NoInheritor.is(moduleError),
    'Expected NoInheritor after revoke',
  )
}

async function controlInheritedAccountFailingCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve, ferdie } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, chain, 0, [bob, charlie])

  const failingCall = client.api.tx.balances.transferKeepAlive(ferdie.address, 10_000n * UNIT)
  const failedControlEvents = await sendTransaction(
    client.api.tx.recovery.controlInheritedAccount(alice.address, failingCall).signAsync(eve),
  )
  await client.dev.newBlock()

  const failedControl = await findEvent(
    failedControlEvents,
    (event) => client.api.events.recovery.RecoveredAccountControlled.is(event),
    'Expected RecoveredAccountControlled event for failing inner call',
  )
  assert(client.api.events.recovery.RecoveredAccountControlled.is(failedControl.event))
  expect(recoveryEventData(failedControl).callResult.isErr).toBe(true)
  expect((await getInheritorState(client, alice.address))!.inheritor).toBe(normalizeAddress(chain, eve.address))

  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const successfulCall = client.api.tx.balances.transferKeepAlive(ferdie.address, UNIT)
  const successfulControlEvents = await sendTransaction(
    client.api.tx.recovery.controlInheritedAccount(alice.address, successfulCall).signAsync(eve),
  )
  await client.dev.newBlock()

  const successfulControl = await findEvent(
    successfulControlEvents,
    (event) => client.api.events.recovery.RecoveredAccountControlled.is(event),
    'Expected RecoveredAccountControlled event for successful inner call',
  )
  assert(client.api.events.recovery.RecoveredAccountControlled.is(successfulControl.event))
  expect(recoveryEventData(successfulControl).callResult.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + UNIT)
}

async function controlInheritedAccountAnyProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, chain, 0, [bob, charlie])

  await sendTransaction(client.api.tx.proxy.addProxy(bob.address, 'Any', 0).signAsync(eve))
  await client.dev.newBlock()

  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const innerCall = client.api.tx.recovery.controlInheritedAccount(
    alice.address,
    client.api.tx.balances.transferKeepAlive(ferdie.address, UNIT),
  )
  const proxyEvents = await sendTransaction(client.api.tx.proxy.proxy(eve.address, null, innerCall).signAsync(bob))
  await client.dev.newBlock()

  const proxyExecuted = await expectProxyExecuted(client, proxyEvents)
  expect(proxyExecuted.result.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + UNIT)
}

async function finishAttemptAtExactBoundaryTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    inheritanceDelay: 2,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, chain, attempt!.initBlock + 2)

  const finishEvents = await sendTransaction(client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    finishEvents,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected AttemptFinished at exact boundary',
  )
}

async function cancelAttemptAtExactBoundaryTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 2,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  await advanceUntilAtLeast(client, chain, attempt!.lastApprovalBlock + 2)

  const cancelEvents = await sendTransaction(client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    cancelEvents,
    (event) => client.api.events.recovery.AttemptCanceled.is(event),
    'Expected AttemptCanceled at exact boundary',
  )
}

async function finishAttemptOddDelayTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    inheritanceDelay: 3,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  const attempt = await getAttemptState(client, alice.address, 0)
  expect(attempt).not.toBeNull()
  const { iterations } = await advanceUntilAtLeast(client, chain, attempt!.initBlock + 3)
  expect(iterations).toBeLessThanOrEqual(2)

  const finishEvents = await sendTransaction(client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await findEvent(
    finishEvents,
    (event) => client.api.events.recovery.AttemptFinished.is(event),
    'Expected AttemptFinished for odd delay',
  )
}

async function cancelBeforeDelayFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    cancelDelay: 20,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const failedCancelEvents = await sendTransaction(
    client.api.tx.recovery.cancelAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedCancelEvents,
    (moduleError) => client.api.errors.recovery.NotYetCancelable.is(moduleError),
    'Expected NotYetCancelable',
  )
}

async function setFriendGroupsWithActiveAttemptFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, dave, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()

  const failedSetGroupEvents = await sendTransaction(
    client.api.tx.recovery
      .setFriendGroups([
        buildGroup(chain, {
          friends: [charlie.address, dave.address],
          friendsNeeded: 2,
          inheritor: eve.address,
          inheritancePriority: 0,
        }),
      ])
      .signAsync(alice),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedSetGroupEvents,
    (moduleError) => client.api.errors.recovery.HasOngoingAttempts.is(moduleError),
    'Expected HasOngoingAttempts',
  )
}

async function thresholdPlusOneApprovalFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, dave, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address, dave.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  const failedApprovalEvents = await sendTransaction(
    client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(dave),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedApprovalEvents,
    (moduleError) => client.api.errors.recovery.AlreadyApproved.is(moduleError),
    'Expected AlreadyApproved',
  )
}

async function finishBeforeDelayFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
    inheritanceDelay: 20,
  })

  await sendTransaction(client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(bob))
  await client.dev.newBlock()
  await sendTransaction(client.api.tx.recovery.approveAttempt(alice.address, 0).signAsync(charlie))
  await client.dev.newBlock()

  const failedFinishEvents = await sendTransaction(
    client.api.tx.recovery.finishAttempt(alice.address, 0).signAsync(bob),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedFinishEvents,
    (moduleError) => client.api.errors.recovery.NotYetInheritable.is(moduleError),
    'Expected NotYetInheritable',
  )
}

async function initiateWhenHigherPriorityRecoveredFailsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, dave, eve, ferdie } = testAccounts

  await configureGroups(client, chain, [
    {
      friends: [bob.address, charlie.address],
      friendsNeeded: 2,
      inheritor: eve.address,
      inheritancePriority: 0,
    },
    {
      friends: [dave.address, ferdie.address],
      friendsNeeded: 2,
      inheritor: ferdie.address,
      inheritancePriority: 1,
    },
  ])

  await completeRecovery(client, chain, 0, [bob, charlie])

  const failedInitiateEvents = await sendTransaction(
    client.api.tx.recovery.initiateAttempt(alice.address, 1).signAsync(dave),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedInitiateEvents,
    (moduleError) => client.api.errors.recovery.HigherPriorityRecovered.is(moduleError),
    'Expected HigherPriorityRecovered',
  )
}

async function notFriendCannotInitiateTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve, ferdie } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  const failedInitiateEvents = await sendTransaction(
    client.api.tx.recovery.initiateAttempt(alice.address, 0).signAsync(ferdie),
  )
  await client.dev.newBlock()
  await expectModuleError(
    client,
    failedInitiateEvents,
    (moduleError) => client.api.errors.recovery.NotFriend.is(moduleError),
    'Expected NotFriend',
  )
}

async function controlInheritedAccountNonTransferProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const client = await setupRecoveryNetwork(chain)
  const { alice, bob, charlie, eve, ferdie } = testAccounts

  await configureSingleGroup(client, chain, {
    friends: [bob.address, charlie.address],
    friendsNeeded: 2,
    inheritor: eve.address,
    inheritancePriority: 0,
  })

  await completeRecovery(client, chain, 0, [bob, charlie])

  await sendTransaction(client.api.tx.proxy.addProxy(bob.address, 'NonTransfer', 0).signAsync(eve))
  await client.dev.newBlock()

  const ferdieBefore = await getFreeBalance(client, ferdie.address)
  const innerCall = client.api.tx.recovery.controlInheritedAccount(
    alice.address,
    client.api.tx.balances.transferKeepAlive(ferdie.address, UNIT),
  )
  const proxyEvents = await sendTransaction(client.api.tx.proxy.proxy(eve.address, null, innerCall).signAsync(bob))
  await client.dev.newBlock()

  const proxyExecuted = await expectProxyExecuted(client, proxyEvents)
  expect(proxyExecuted.result.isOk).toBe(true)
  expect(await getFreeBalance(client, ferdie.address)).toBe(ferdieBefore + UNIT)
}

function successRecoveryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'success tests',
    children: [
      {
        kind: 'test',
        label: 'full lifecycle: set_friend_groups → initiate → approve × 2 → finish → control',
        testFn: () => fullLifecycleTest(chain),
      },
      {
        kind: 'test',
        label: 'initiator cancels attempt after cancel_delay passes',
        testFn: () => initiatorCancelsAfterDelayTest(chain),
      },
      {
        kind: 'test',
        label: 'lost account cancels attempt immediately without delay',
        testFn: () => lostAccountCancelsImmediatelyTest(chain),
      },
      {
        kind: 'test',
        label: 'lost account slashes attempt — initiator bond is not returned',
        testFn: () => lostAccountSlashesAttemptTest(chain),
      },
      {
        kind: 'test',
        label: 'approval resets the cancel timer — slash window extended after each vote',
        testFn: () => approvalResetsTimerTest(chain),
      },
      {
        kind: 'test',
        label: 'inheritance order conflict: discard of lower-priority, displacement by higher-priority',
        testFn: () => inheritanceOrderConflictTest(chain),
      },
      {
        kind: 'test',
        label: 'revoke_inheritor clears inheritor storage and releases hold',
        testFn: () => revokeInheritorTest(chain),
      },
      {
        kind: 'test',
        label: 'control_inherited_account with failing inner call preserves inheritor relationship',
        testFn: () => controlInheritedAccountFailingCallTest(chain),
      },
      {
        kind: 'test',
        label: 'control_inherited_account executes successfully through Any proxy',
        testFn: () => controlInheritedAccountAnyProxyTest(chain),
      },
      {
        kind: 'test',
        label: 'control_inherited_account passes through NonTransfer proxy — intentionally not excluded',
        testFn: () => controlInheritedAccountNonTransferProxyTest(chain),
      },
      {
        kind: 'test',
        label: 'finish_attempt succeeds at exactly inheritance_delay blocks (even delay)',
        testFn: () => finishAttemptAtExactBoundaryTest(chain),
      },
      {
        kind: 'test',
        label: 'cancel_attempt succeeds at exactly cancel_delay blocks (even delay)',
        testFn: () => cancelAttemptAtExactBoundaryTest(chain),
      },
      {
        kind: 'test',
        label: 'finish_attempt with odd inheritance_delay is reachable within two newBlock() calls',
        testFn: () => finishAttemptOddDelayTest(chain),
      },
    ],
  }
}

function failureRecoveryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'failure tests',
    children: [
      {
        kind: 'test',
        label: 'initiator cannot cancel before cancel_delay',
        testFn: () => cancelBeforeDelayFailsTest(chain),
      },
      {
        kind: 'test',
        label: 'set_friend_groups fails when attempt is active',
        testFn: () => setFriendGroupsWithActiveAttemptFailsTest(chain),
      },
      {
        kind: 'test',
        label: 'approve_attempt fails when threshold already met',
        testFn: () => thresholdPlusOneApprovalFailsTest(chain),
      },
      {
        kind: 'test',
        label: 'finish_attempt fails before inheritance_delay',
        testFn: () => finishBeforeDelayFailsTest(chain),
      },
      {
        kind: 'test',
        label: 'initiate_attempt fails when higher-priority group already recovered',
        testFn: () => initiateWhenHigherPriorityRecoveredFailsTest(chain),
      },
      {
        kind: 'test',
        label: 'non-friend cannot initiate recovery attempt',
        testFn: () => notFriendCannotInitiateTest(chain),
      },
    ],
  }
}

export function baseRecoveryE2Etests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [successRecoveryE2ETests(chain), failureRecoveryE2ETests(chain)],
  }
}
