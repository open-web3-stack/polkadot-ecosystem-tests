import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'

import type { Option } from '@polkadot/types'
import type { ParaInfo } from '@polkadot/types/interfaces'
import type { PolkadotRuntimeParachainsConfigurationHostConfiguration } from '@polkadot/types/lookup'
import { compactAddLength, u8aToHex } from '@polkadot/util'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'
import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin, setupNetworks } from './index.js'
import type { Client, RootTestTree } from './types.js'

const devAccounts = defaultAccountsSr25519

const GENESIS_HEAD = new Uint8Array([0x00])
const MINIMAL_VALIDATION_CODE = u8aToHex(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]),
)

async function fundAccounts(client: Client<any, any>): Promise<void> {
  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: 100000e10 } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })
}

async function forceRegisterParaViaRoot(
  client: Client<any, any>,
  chain: Chain<any, any>,
  manager: string,
  paraId: number,
): Promise<void> {
  const tx = client.api.tx.registrar.forceRegister(manager, BigInt(0), paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE)
  await scheduleInlineCallWithOrigin(
    client,
    tx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  const events = await client.api.query.system.events()
  const [regEvent] = events.filter(({ event }) => event.section === 'registrar' && event.method === 'Registered')
  assert(client.api.events.registrar.Registered.is(regEvent.event))
  expect(regEvent.event.data[0].toString()).toBe(paraId.toString())
}

async function addLockViaRoot(client: Client<any, any>, chain: Chain<any, any>, paraId: number): Promise<void> {
  const tx = client.api.tx.registrar.addLock(paraId)
  await scheduleInlineCallWithOrigin(
    client,
    tx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
}

/**
 * Test the process of
 * 1. reserving a para ID
 *
 *     1.1 asserting that the para ID was successfully reserved by alice and para info is correct
 *
 *     1.2 asserting that para deposit is reserved
 *
 *     1.3 asserting that non-owner cannot register para
 *
 *     1.4 asserting Bob's frozen funds is equal to delegation amount
 *
 * 2. registering para
 *
 *     2.1 asserting that register by alice was successful
 *
 *     2.2 asserting that new reserved balance includes additional deposit from registration
 *
 *     2.3 asserting that alice cannot register para ID twice
 *
 * 3. deregistering para
 *
 *     3.1 asserting that non-owner cannot deregister para
 *
 *     3.2 asserting para deregister and events
 *
 *     3.3 asserting that reserved balance is removed after deregister
 *
 *     3.4 asserting that paras entry is gone
 */
export async function parasRegistrationE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await fundAccounts(client)

  const paraDeposit = client.api.consts.registrar.paraDeposit
  const paraDepositBigInt = BigInt(paraDeposit.toString())
  const dataDepositPerByte = BigInt(client.api.consts.registrar.dataDepositPerByte.toString())
  const config =
    (await client.api.query.configuration.activeConfig()) as PolkadotRuntimeParachainsConfigurationHostConfiguration
  const maxCodeSize = BigInt(config.maxCodeSize.toString())
  const totalDeposit = paraDepositBigInt + dataDepositPerByte * maxCodeSize
  const additionalNeeded = totalDeposit - paraDepositBigInt

  // 1. Reserve a para ID
  const reserveTx = client.api.tx.registrar.reserve()
  const reserveEvent = await sendTransaction(reserveTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  // Assert reserve events
  const unwantedFields = /Id/
  await checkEvents(reserveEvent, 'registrar')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('registrar reserve events')

  const systemEvents = await client.api.query.system.events()
  const [resEvent] = systemEvents.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Reserved'
  })
  assert(client.api.events.registrar.Reserved.is(resEvent.event))

  // 1.1 Assert para events
  const reserveEventData = resEvent.event.data
  const paraId = reserveEventData[0].toString()
  expect(reserveEventData[1].toString()).toBe(
    encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding),
  )

  // Assert that para info is correct
  const parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  const paras = parasOption.unwrap()

  expect(paras.manager.toString()).toBe(encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding))
  expect(paras.deposit.toString()).toBe(paraDeposit.toString())
  expect(paras.locked.isEmpty).toBe(true)

  // 1.2 Assert that the reserved balance is correct
  let aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  expect(aliceBalance.data.reserved.toString()).toBe(paraDeposit.toString())

  // 1.3 Assert that bob (not owner) cannot register the para
  const registerTxBob = client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE)
  const registerEventsBob = await sendTransaction(registerTxBob.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  await checkEvents(registerEventsBob, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('bob para register failed event')

  // 2. Test that alice can register the para
  const registerTx = client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE)
  const registerEvents = await sendTransaction(registerTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  // 2.1 Assert register events
  await checkEvents(registerEvents, 'registrar')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('registrar register events')

  // Verify Registered event data
  const systemEventsAfterRegister = await client.api.query.system.events()
  const [regEvent] = systemEventsAfterRegister.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Registered'
  })
  assert(client.api.events.registrar.Registered.is(regEvent.event))
  expect(regEvent.event.data[0].toString()).toBe(paraId)
  expect(regEvent.event.data[1].toString()).toBe(
    encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding),
  )

  // 2.2 Assert that the new reserved balance includes additional deposit from registration
  aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  expect(aliceBalance.data.reserved.toString()).toBe((paraDepositBigInt + additionalNeeded).toString())

  // 2.3 alice trying to register again with the same paraId should fail
  const registerTxDuplicate = client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE)
  const registerEventsDuplicate = await sendTransaction(registerTxDuplicate.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  await checkEvents(registerEventsDuplicate, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('alice duplicate para register failed event')

  // 3. Deregister para
  // set para lifecycle state directly
  await client.dev.setStorage({
    Paras: {
      paraLifecycles: [[[parseInt(paraId, 10)], 'Parathread']],
    },
  })

  // 3.1 Assert that bob (not owner) cannot deregister the para
  const deregisterTxBob = client.api.tx.registrar.deregister(paraId)
  const deregisterEventsBob = await sendTransaction(deregisterTxBob.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  await checkEvents(deregisterEventsBob, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('bob para deregister failed event')

  // 3.2 Alice deregisters the para
  const deregisterTx = client.api.tx.registrar.deregister(paraId)
  await sendTransaction(deregisterTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  // Verify deregistered event data
  const systemEventsAfterDeregister = await client.api.query.system.events()

  const [deregEvent] = systemEventsAfterDeregister.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Deregistered'
  })
  assert(client.api.events.registrar.Deregistered.is(deregEvent.event))
  expect(deregEvent.event.data[0].toString()).toBe(paraId)

  // 3.3 Assert that all reserved balance is returned after deregistration
  aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  expect(aliceBalance.data.reserved.toString()).toBe('0')

  // 3.4 Assert paras entry is gone
  const parasOptionAfter = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOptionAfter.isSome).toBe(false)
}

/**
 * Test the process of
 * 1. reserving a para ID via Root origin
 *
 *     1.1 asserting that the para ID was successfully registered by Root call
 *
 *     1.2 asserting that bob was set as manager for reserved para
 *
 * 2. adding and removing lock
 *
 *     2.1 applying lock via root
 *
 *     2.2 asserting that locked is true
 *
 *     2.3 removing lock via root
 *
 *     2.4 asserting that locked is false
 *
 * 3. deregistering para via Root origin
 *
 *     3.1 asserting events that deregister of para was successful
 *
 *     3.2 asserting para entry is no longer present
 */
export async function parasRootRegistrationE2eTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Pay 0 DOT for registration
  const paraDepositBigInt = BigInt(0)

  // Query the next free para ID so we don't collide with an already-registered para (e.g. Acala=2000)
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  // 1.1 force_register via Root — sets Bob as manager, asserts Registered event
  await forceRegisterParaViaRoot(client, chain, devAccounts.bob.address, paraId)

  // 1.2 Assert ParaInfo has Bob as manager and correct deposit
  let parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  let paras = parasOption.unwrap()
  expect(paras.manager.toString()).toBe(encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding))
  expect(paras.deposit.toString()).toBe(paraDepositBigInt.toString())
  expect(paras.locked.isEmpty).toBe(true)

  // Assert the deposit was reserved from Bob's account
  const bobBalanceAfter = await client.api.query.system.account(devAccounts.bob.address)
  expect(bobBalanceAfter.data.reserved.toString()).toBe(paraDepositBigInt.toString())

  // 2. Apply lock via Root
  await addLockViaRoot(client, chain, paraId)

  // 2.2 Assert locked is true
  parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  paras = parasOption.unwrap()
  expect(paras.locked.toHuman()).toBe(true)

  // 2.3 Remove lock via Root
  const removeLockTx = client.api.tx.registrar.removeLock(paraId)
  await scheduleInlineCallWithOrigin(
    client,
    removeLockTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 2.4 Assert locked is false
  parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  paras = parasOption.unwrap()
  expect(paras.locked.toHuman()).toBe(false)

  // 3. Deregister the para via Root origin
  // set para lifecycle state directly
  await client.dev.setStorage({
    Paras: {
      paraLifecycles: [[[paraId], 'Parathread']],
    },
  })

  const deregisterTx = client.api.tx.registrar.deregister(paraId)
  await scheduleInlineCallWithOrigin(
    client,
    deregisterTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3.1 Assert Deregistered event
  const systemEventsAfterDeregister = await client.api.query.system.events()
  const [deregEvent] = systemEventsAfterDeregister.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Deregistered'
  })
  assert(client.api.events.registrar.Deregistered.is(deregEvent.event))
  expect(deregEvent.event.data[0].toString()).toBe(paraId.toString())

  // 3.2 Assert paras entry is gone
  const parasOptionAfter = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOptionAfter.isSome).toBe(false)
}

/**
 * Test the process of
 * 1. swapping with same ID
 *
 *     1.1 asserting that no swap event was emmited
 *
 *     1.2 asserting that no pending swap stored
 *
 * 2. swapping two Parathreads
 *
 *     2.1 asserting that no swap event was emmited
 *
 *     2.2 asserting that pending swap was stored
 *
 *     2.2 asserting that cannot swap two parathreads
 *
 * 3. swapping a Parathread and a Parachain
 *
 *     3.1 asserting that Alice successfuly initiates swap
 *
 *     3.2 asserting that Bob successfully confirms swap
 *
 *     3.3 asserting successful swap events
 *
 * 4. swapping a Parachain and a Parachain
 *
 *     4.1 asserting that Alice successfuly initiates swap
 *
 *     4.2 asserting that Bob successfully confirms swap
 *
 *     4.3 asserting successful swap events
 */

/**
 * Test all swap cases in the registrar pallet:
 *
 * 1. Same ID → no-op (clears pending swap, no Swapped event)
 * 2. First call → PendingSwap stored, no Swapped event yet
 * 3. Cannot swap → both Parathreads confirming swap → CannotSwap error
 * 4. Parachain ↔ Parathread confirmed swap → Swapped event
 * 5. Parachain ↔ Parachain confirmed swap → Swapped event
 */
export async function parasRegistrarSwapE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await fundAccounts(client)

  // Register para A (Alice manager) and para B (Bob manager) via Root
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraIdA = parseInt(nextFreeParaId.toString(), 10)
  const paraIdB = paraIdA + 1

  await forceRegisterParaViaRoot(client, chain, devAccounts.alice.address, paraIdA)
  await forceRegisterParaViaRoot(client, chain, devAccounts.bob.address, paraIdB)

  // 1. Swapping with same ID - no-op
  const swapSameIdTx = client.api.tx.registrar.swap(paraIdA, paraIdA)
  await sendTransaction(swapSameIdTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  const eventsAfterSameSwap = await client.api.query.system.events()

  // 1.1 No Swapped event emitted
  const swappedEventSame = eventsAfterSameSwap.find(
    ({ event }) => event.section === 'registrar' && event.method === 'Swapped',
  )
  expect(swappedEventSame).toBeUndefined()

  // 1.2 No pending swap stored
  const pendingSwapSame = await client.api.query.registrar.pendingSwap(paraIdA)
  expect(pendingSwapSame.isEmpty).toBe(true)

  // 2. Swapping Parathreads
  await client.dev.setStorage({
    Paras: {
      paraLifecycles: [
        [[paraIdA], 'Parathread'],
        [[paraIdB], 'Parathread'],
      ],
    },
  })

  const swapFirstTx = client.api.tx.registrar.swap(paraIdA, paraIdB)
  await sendTransaction(swapFirstTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  // 2.1 No Swapped event yet
  const eventsAfterFirstSwap = await client.api.query.system.events()
  const swappedEventFirst = eventsAfterFirstSwap.find(
    ({ event }) => event.section === 'registrar' && event.method === 'Swapped',
  )
  expect(swappedEventFirst).toBeUndefined()

  // 2.2 Pending swap was stored
  const pendingSwapAfterFirst = await client.api.query.registrar.pendingSwap(paraIdA)
  expect(pendingSwapAfterFirst.toString()).toBe(paraIdB.toString())

  // 2.3 Assert that cannot swap two parathreads
  const swapCannotTx = client.api.tx.registrar.swap(paraIdB, paraIdA)
  await sendTransaction(swapCannotTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'cannot swap two parathreads',
  )

  // 3. Swapping a Parathread and a Parachain
  // Clear pending swap from case 2, set A=Parachain, B=Parathread
  await client.dev.setStorage({
    Registrar: {
      pendingSwap: [
        [[paraIdA], null],
        [[paraIdB], null],
      ],
    },
    Paras: {
      paraLifecycles: [
        [[paraIdA], 'Parachain'],
        [[paraIdB], 'Parathread'],
      ],
    },
  })

  // 3.1 Alice initiates: A ↔ B
  const swapChainThreadFirstTx = client.api.tx.registrar.swap(paraIdA, paraIdB)
  await sendTransaction(swapChainThreadFirstTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()
  const pendingSwapChainThread = await client.api.query.registrar.pendingSwap(paraIdA)
  expect(pendingSwapChainThread.toString()).toBe(paraIdB.toString())

  // 3.2 Bob confirms: B ↔ A
  const swapChainThreadSecondTx = client.api.tx.registrar.swap(paraIdB, paraIdA)
  await sendTransaction(swapChainThreadSecondTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  const eventsAfterChainThreadSwap = await client.api.query.system.events()
  const [chainThreadSwapEvent] = eventsAfterChainThreadSwap.filter(
    ({ event }) => event.section === 'registrar' && event.method === 'Swapped',
  )
  assert(client.api.events.registrar.Swapped.is(chainThreadSwapEvent.event))

  // 3.3 Asserting swap events
  expect(chainThreadSwapEvent.event.data[0].toString()).toBe(paraIdB.toString())
  expect(chainThreadSwapEvent.event.data[1].toString()).toBe(paraIdA.toString())

  // 4: Parachain and Parachain confirmed swap
  await client.dev.setStorage({
    Registrar: {
      pendingSwap: [
        [[paraIdA], null],
        [[paraIdB], null],
      ],
    },
    Paras: {
      paraLifecycles: [
        [[paraIdA], 'Parachain'],
        [[paraIdB], 'Parachain'],
      ],
    },
  })

  // 4.1 Alice initiates: A ↔ B
  const swapChainChainFirstTx = client.api.tx.registrar.swap(paraIdA, paraIdB)
  await sendTransaction(swapChainChainFirstTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()
  const pendingSwapChainChain = await client.api.query.registrar.pendingSwap(paraIdA)
  expect(pendingSwapChainChain.toString()).toBe(paraIdB.toString())

  // 4.2 Bob confirms: B ↔ A
  const swapChainChainSecondTx = client.api.tx.registrar.swap(paraIdB, paraIdA)
  await sendTransaction(swapChainChainSecondTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  // 4.3 Assert swap events
  const eventsAfterChainChainSwap = await client.api.query.system.events()
  const [chainChainSwapEvent] = eventsAfterChainChainSwap.filter(
    ({ event }) => event.section === 'registrar' && event.method === 'Swapped',
  )
  assert(client.api.events.registrar.Swapped.is(chainChainSwapEvent.event))
  expect(chainChainSwapEvent.event.data[0].toString()).toBe(paraIdB.toString())
  expect(chainChainSwapEvent.event.data[1].toString()).toBe(paraIdA.toString())
}

/**
 * Test the process of
 *
 * 1. asserting that non-owner (Bob) cannot schedule code upgrade
 *
 * 2. asserting that manager (Alice) can schedule code upgrade
 *
 * 3. asserting that Root call can lock para
 *
 * 4. asserting that Manager cannot schedule code upgrade for locked para
 *
 * 5. asserting that Root can schedule a code upgrade even when locked
 *
 */
export async function parasScheduleCodeUpgradeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await fundAccounts(client)

  const newValidationCode = u8aToHex(
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00]),
  )

  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  await forceRegisterParaViaRoot(client, chain, devAccounts.alice.address, paraId)

  // 1. Non-owner (Bob) cannot schedule a code upgrade
  const scheduleUpgradeBobTx = client.api.tx.registrar.scheduleCodeUpgrade(paraId, newValidationCode)
  const scheduleUpgradeBobEvents = await sendTransaction(scheduleUpgradeBobTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  const unwantedFields = /Id/
  await checkEvents(scheduleUpgradeBobEvents, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('bob schedule code upgrade failed')

  // 2. Manager (Alice) can schedule a code upgrade
  const scheduleUpgradeAliceTx = client.api.tx.registrar.scheduleCodeUpgrade(paraId, newValidationCode)
  const scheduleUpgradeAliceEvents = await sendTransaction(scheduleUpgradeAliceTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  await checkEvents(scheduleUpgradeAliceEvents, 'paras', 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('alice schedule code upgrade success')

  // 3. Lock the para via Root
  await addLockViaRoot(client, chain, paraId)

  const parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  expect(parasOption.unwrap().locked.toHuman()).toBe(true)

  // 4. Manager (Alice) cannot schedule a code upgrade when para is locked
  const scheduleUpgradeAliceLockedTx = client.api.tx.registrar.scheduleCodeUpgrade(paraId, newValidationCode)
  const scheduleUpgradeAliceLockedEvents = await sendTransaction(
    scheduleUpgradeAliceLockedTx.signAsync(devAccounts.alice),
  )
  await client.dev.newBlock()

  await checkEvents(scheduleUpgradeAliceLockedEvents, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('alice locked schedule code upgrade failed')

  // 5. Root can schedule a code upgrade even when locked
  const scheduleUpgradeRootTx = client.api.tx.registrar.scheduleCodeUpgrade(paraId, newValidationCode)
  await scheduleInlineCallWithOrigin(
    client,
    scheduleUpgradeRootTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  await checkSystemEvents(client, 'paras')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('root schedule code upgrade success')
}

/**
 * Test the process of
 *
 * 1. asserting that non-owner (Bob) cannot set the current head
 *
 * 2. asserting that manager (Alice) can set the current head
 *
 * 3. asserting that Root call can lock para
 *
 * 4. asserting that Manager cannot set the current head for locked para
 *
 *     4.1 asserting that head should be unchanged
 *
 * 5. asserting that Root can set the current head even when locked
 *
 */
export async function parasSetCurrentHeadE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await fundAccounts(client)

  const newHeadRaw = new Uint8Array([0x01, 0x02, 0x03])
  const newHead = u8aToHex(newHeadRaw)
  const newHeadHex = u8aToHex(compactAddLength(newHeadRaw))

  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  await forceRegisterParaViaRoot(client, chain, devAccounts.alice.address, paraId)

  // 1. Non-owner (Bob) cannot set the current head
  const setHeadBobTx = client.api.tx.registrar.setCurrentHead(paraId, newHead)
  const setHeadBobEvents = await sendTransaction(setHeadBobTx.signAsync(devAccounts.bob))
  await client.dev.newBlock()

  await checkEvents(setHeadBobEvents, 'system')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('bob set current head failed')

  // 2. Manager (Alice, unlocked) can set the current head
  const setHeadAliceTx = client.api.tx.registrar.setCurrentHead(paraId, newHead)
  await sendTransaction(setHeadAliceTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  const headAfterAlice = await client.api.query.paras.heads(paraId)
  expect(headAfterAlice.toHex()).toBe(newHeadHex)

  // 3. Lock the para via Root
  await addLockViaRoot(client, chain, paraId)

  const parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  expect(parasOption.unwrap().locked.toHuman()).toBe(true)

  // 4. Manager (Alice, locked) cannot set the current head
  const updatedHeadRaw = new Uint8Array([0x04, 0x05, 0x06])
  const updatedHead = u8aToHex(updatedHeadRaw)
  const setHeadAliceLockedTx = client.api.tx.registrar.setCurrentHead(paraId, updatedHead)
  const setHeadAliceLockedEvents = await sendTransaction(setHeadAliceLockedTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  await checkEvents(setHeadAliceLockedEvents, 'system')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('alice locked set current head failed')

  // 4.1 Head should be unchanged
  const headAfterAliceLocked = await client.api.query.paras.heads(paraId)
  expect(headAfterAliceLocked.toHex()).toBe(newHeadHex)

  // 5. Root can set the current head even when locked
  const setHeadRootTx = client.api.tx.registrar.setCurrentHead(paraId, updatedHead)
  await scheduleInlineCallWithOrigin(
    client,
    setHeadRootTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const headAfterRoot = await client.api.query.paras.heads(paraId)
  expect(headAfterRoot.toHex()).toBe(u8aToHex(compactAddLength(updatedHeadRaw)))
}

export function registrarE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'pallet registrar - reserve and registration functions',
        testFn: async () => await parasRegistrationE2ETest(chain),
      },
      {
        kind: 'test',
        label: 'pallet registrar - root registration functions',
        testFn: async () => await parasRootRegistrationE2eTest(chain),
      },
      {
        kind: 'test',
        label: 'pallet registrar - swap functions',
        testFn: async () => await parasRegistrarSwapE2ETest(chain),
      },
      {
        kind: 'test',
        label: 'pallet registrar - schedule code upgrade',
        testFn: async () => await parasScheduleCodeUpgradeE2ETest(chain),
      },
      {
        kind: 'test',
        label: 'pallet registrar - set current head',
        testFn: async () => await parasSetCurrentHeadE2ETest(chain),
      },
    ],
  }
}
