import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'

import type { KeyringPair } from '@polkadot/keyring/types'
import type { Option } from '@polkadot/types'
import type { ParaInfo } from '@polkadot/types/interfaces'
import type { PolkadotRuntimeParachainsConfigurationHostConfiguration } from '@polkadot/types/lookup'
import { compactAddLength, hexToU8a, u8aToHex } from '@polkadot/util'
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'
import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin, setupNetworks } from './index.js'
import type { Client, RootTestTree } from './types.js'

const devAccounts = testAccounts

/**
 * The Genesis Head is the first block header of a parachain.
 * It's a series of bytes that stores the hash of the starting state for that chain.
 */
const GENESIS_HEAD = new Uint8Array([0x00])

/**
 * This is the compiled WASM runtime that validators run to verify if a block is valid.
 * It is stored and executed by the relay chain.
 * It's the smallest structurally valid WASM binary for test purposes, it contains no actual content.
 * The breakdown is as follows;
 * WASM Magic Number (\0asm)             - 0x00, 0x61, 0x73, 0x6d
 * WASM Version (1 - little endian, u32) - 0x01, 0x00, 0x00, 0x00
 * Section ID (1)                        - 0x01
 * Section Byte length (1)               - 0x01
 * Content (0)                           - 0x00
 */
const MINIMAL_VALIDATION_CODE = u8aToHex(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]),
)

/**
 * Helper to fund accounts
 */
async function fundAccounts(client: Client<any, any>): Promise<void> {
  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: 100000e10 } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: 100000e10 } }],
        [[devAccounts.charlie.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })
}

/**
 * Helper to submit an extrinsic with a user account and advance the blockchain state
 */
async function submitAndAdvanceBlock(
  client: Client<any, any>,
  tx: { signAsync: (signer: KeyringPair) => Parameters<typeof sendTransaction>[0] },
  signer: KeyringPair,
): Promise<Awaited<ReturnType<typeof sendTransaction>>> {
  const result = await sendTransaction(tx.signAsync(signer))
  await client.dev.newBlock()
  return result
}

/**
 * Helper to send the force_register extrinsic via root with an inline call, advance the blockchain state
 *  and assert the register events
 */
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

/**
 * Helper to send the addLock extrinsic via root with an inline call, advance the blockchain state.
 */
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
 * Test the process of reserving a para ID;
 *
 *     1. asserting that non-root user cannot register a para ID without reserving
 *
 *     2. asserting that the para ID was successfully reserved by alice and para info is correct
 *
 *     3. asserting that para deposit is reserved
 *
 *     4. asserting that cannot reserve para with an already registered ID
 *
 *     5. asserting that cannot reserve para when lifecycles entry with ID exists
 */
export async function paraReservingE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await fundAccounts(client)

  const paraDeposit = client.api.consts.registrar.paraDeposit
  const nextFreeParaId = (await client.api.query.registrar.nextFreeParaId()).toString()
  const unreservedRegisterEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(nextFreeParaId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.alice,
  )
  await checkEvents(unreservedRegisterEvents, 'system').toMatchSnapshot('register para without reserving')

  const reserveEvent = await submitAndAdvanceBlock(client, client.api.tx.registrar.reserve(), devAccounts.alice)

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

  // 2. Assert para events
  const reserveEventData = resEvent.event.data
  const paraId = reserveEventData[0].toString()
  expect(paraId).toEqual(nextFreeParaId)
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

  // 3. Assert that the reserved balance is correct
  const aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  expect(aliceBalance.data.reserved.toString()).toBe(paraDeposit.toString())

  // 4. Assert error response when trying to reserve an existing para ID
  // Force-set NextFreeParaId to previously reserved paraId to trigger first AlreadyRegistered error
  await client.dev.setStorage({
    Registrar: {
      NextFreeParaId: paraId,
    },
  })

  const existingParaReserveEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.reserve(),
    devAccounts.alice,
  )
  await checkEvents(existingParaReserveEvents, 'system').toMatchSnapshot(
    'cannot reserve para with existing ParaLifecycles ID',
  )

  // 5. Assert error response when trying to reserve an existing lifecycle ID from Paras pallet
  // Force-set ParasLifecycles to trigger second AlreadyRegistered error
  await client.dev.setStorage({
    Registrar: {
      NextFreeParaId: null,
    },
    Paras: {
      ParaLifecycles: [[[paraId], 'Parachain']],
    },
  })

  const lifecycleReserveEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.reserve(),
    devAccounts.alice,
  )
  await checkEvents(lifecycleReserveEvents, 'system').toMatchSnapshot('cannot reserve para with existing para ID')

  // Undo storage set
  await client.dev.setStorage({
    Paras: {
      ParaLifecycles: [[[paraId], null]],
    },
  })
}

/**
 * Test the process of registering para;
 *
 *     1. asserting that cannot register para without resreving
 *
 *     2. asserting that non-manager cannot register para
 *
 *     3. asserting that cannot register locked para
 *
 *     4. asserting that cannot register para when lifecycles entry with ID exists
 *
 *     5. asserting that register by alice was successful
 *
 *     6. asserting that new reserved balance includes additional deposit from registration
 *
 *     7. asserting that alice cannot register para ID twice
 */
export async function paraRegisteringE2ETest<
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

  const nextFreeParaId = (await client.api.query.registrar.nextFreeParaId()).toString()

  // 1. Assert that cannot register para without reserving
  const unreservedRegisterEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(nextFreeParaId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.alice,
  )
  await checkEvents(unreservedRegisterEvents, 'system').toMatchSnapshot('register para without reserving')
  const unwantedFields = /Id/

  // Reserve para in preparation for register tests
  await submitAndAdvanceBlock(client, client.api.tx.registrar.reserve(), devAccounts.alice)
  const systemEvents = await client.api.query.system.events()
  const [resEvent] = systemEvents.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Reserved'
  })
  const reserveEventData = resEvent.event.data
  const paraId = reserveEventData[0].toString()

  // 2. Assert that non-manager cannot register para
  const nonOwnerRegisterEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.bob,
  )
  await checkEvents(nonOwnerRegisterEvents, 'system').toMatchSnapshot('non-manager cannot register para')

  // 3. Assert that cannot register Locked Para
  {
    // Lock the para by setting its info with locked = true
    const paraInfo = await client.api.query.registrar.paras(paraId)
    await client.dev.setStorage({
      Registrar: {
        Paras: [[[paraId], { ...(paraInfo.toJSON() as object), locked: true }]],
      },
    })

    const lockedRegisterEvents = await submitAndAdvanceBlock(
      client,
      client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
      devAccounts.alice,
    )
    await checkEvents(lockedRegisterEvents, 'system').toMatchSnapshot('cannot register locked para')

    // Restore unlocked state
    await client.dev.setStorage({
      Registrar: {
        Paras: [[[paraId], { ...(paraInfo.toJSON() as object), locked: null }]],
      },
    })
  }

  // Give paraId an existing lifecycle to simulate an already-registered para
  await client.dev.setStorage({
    Paras: {
      ParaLifecycles: [[[paraId], 'Parachain']],
    },
  })

  // 4. Assert that cannot register para when lifecycle entry exists
  const lifecycleRegisterEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.alice,
  )
  await checkEvents(lifecycleRegisterEvents, 'system').toMatchSnapshot('cannot register para with existing lifecycle')

  // Clear the lifecycle so the actual registration below can proceed
  await client.dev.setStorage({
    Paras: {
      ParaLifecycles: [[[paraId], null]],
    },
  })

  // 5. Assert register events
  const registerEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.alice,
  )

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

  // 6. Assert that the new reserved balance includes additional deposit from registration
  const aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  expect(aliceBalance.data.reserved.toString()).toBe((paraDepositBigInt + additionalNeeded).toString())

  // 7. alice trying to register again with the same paraId should fail
  const registerEventsDuplicate = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.alice,
  )

  await checkEvents(registerEventsDuplicate, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('alice duplicate para register failed event')
  const nonParathreadDeregisterEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.deregister(paraId),
    devAccounts.alice,
  )
  await checkEvents(nonParathreadDeregisterEvents, 'system').toMatchSnapshot('deregister non-parathread')
}

/**
 * Test the process of deregistering a para;
 *
 *     1. asserting that cannot deregister non-parathread
 *
 *     2. asserting that cannot deregister para ID when PvfActiveVoteList contains future hash code
 *
 *     3. asserting that non-owner cannot deregister para
 *
 *     4. asserting para deregister and events
 *
 *     5. asserting that reserved balance is removed after deregister
 *
 *     6. asserting that paras entry is gone
 */
export async function paraDeregisteringE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await fundAccounts(client)

  const nextFreeParaId = (await client.api.query.registrar.nextFreeParaId()).toString()
  const unreservedRegisterEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(nextFreeParaId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.alice,
  )
  await checkEvents(unreservedRegisterEvents, 'system').toMatchSnapshot('register para without reserving')

  // Reserve para in preparation for deregsiter tests
  const reserveEvent = await submitAndAdvanceBlock(client, client.api.tx.registrar.reserve(), devAccounts.alice)

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

  const reserveEventData = resEvent.event.data
  const paraId = reserveEventData[0].toString()

  // Register para in preparation for deregister tests
  await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.register(paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE),
    devAccounts.alice,
  )

  // 1. Assert that cannot deregister non-parathread
  const nonParathreadDeregisterEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.deregister(paraId),
    devAccounts.alice,
  )
  await checkEvents(nonParathreadDeregisterEvents, 'system').toMatchSnapshot('deregister non-parathread')

  // 2. Assert CannotDeregister error when PvfActiveVoteList contains future hash code
  {
    // A fake 32-byte validation code hash (use any consistent value)
    const fakeCodeHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    await client.dev.setStorage({
      paras: {
        paraLifecycles: [[[paraId], 'Parathread']],
        futureCodeHash: [[[paraId], fakeCodeHash]],
        pvfActiveVoteList: [fakeCodeHash],
      },
    })

    const pvfVoteDeregisterEvents = await submitAndAdvanceBlock(
      client,
      client.api.tx.registrar.deregister(paraId),
      devAccounts.alice,
    )
    await checkEvents(pvfVoteDeregisterEvents, 'system').toMatchSnapshot('cannot deregister para with active PVF vote')
  }

  // update para lifecycle state
  await client.dev.setStorage({
    Paras: {
      ParaLifecycles: [[[paraId], 'Parathread']],
      futureCodeHash: [[[paraId], null]],
      pvfActiveVoteList: [null],
    },
  })

  // 3. Assert that bob (not owner) cannot deregister the para
  const deregisterEventsBob = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.deregister(paraId),
    devAccounts.bob,
  )

  await checkEvents(deregisterEventsBob, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('bob para deregister failed event')

  // 4. Alice deregisters the para
  const deregisterEventsAlice = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.deregister(paraId),
    devAccounts.alice,
  )

  // Verify deregistered event data
  await checkEvents(deregisterEventsAlice, 'registrar')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('alice deregister event')

  const systemEventsAfterDeregister = await client.api.query.system.events()

  const [deregEvent] = systemEventsAfterDeregister.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Deregistered'
  })
  assert(client.api.events.registrar.Deregistered.is(deregEvent.event))
  expect(deregEvent.event.data[0].toString()).toBe(paraId)

  // 5. Assert that all reserved balance is returned after deregistration
  const aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  expect(aliceBalance.data.reserved.toString()).toBe('0')

  // 6. Assert paras entry is gone
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
  await checkSystemEvents(client, { section: 'registrar', method: 'Deregistered' })
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('root deregister event')

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
 *     1.1 asserting that non-owner cannot register swap
 *
 *     1.2 asserting that no swap event was emmited
 *
 *     1.3 asserting that no pending swap stored
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
 * 4. swapping a Parachain and a Parathread
 *
 *     4.1 asserting that Alice successfuly initiates swap
 *
 *     4.2 asserting that Bob successfully confirms swap
 *
 *     4.3 asserting successful swap events
 *
 * 5. swapping a Parachain and a Parachain
 *
 *     5.1 asserting that Alice successfuly initiates swap
 *
 *     5.2 asserting that Bob successfully confirms swap
 *
 *     5.3 asserting successful swap events
 *
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

  // 1.1 Assert that non-owner cannot register swap
  const nonOwnerSwapEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.swap(paraIdA, paraIdB),
    devAccounts.charlie,
  )
  await checkEvents(nonOwnerSwapEvents, 'system').toMatchSnapshot('non-owner cannot register swap')

  await submitAndAdvanceBlock(client, client.api.tx.registrar.swap(paraIdA, paraIdA), devAccounts.alice)
  const eventsAfterSameSwap = await client.api.query.system.events()

  // 1.2 No Swapped event emitted
  const swappedEventSame = eventsAfterSameSwap.find(
    ({ event }) => event.section === 'registrar' && event.method === 'Swapped',
  )
  expect(swappedEventSame).toBeUndefined()

  // 1.3 No pending swap stored
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

  await submitAndAdvanceBlock(client, client.api.tx.registrar.swap(paraIdA, paraIdB), devAccounts.alice)

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
  const cannotSwapEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.swap(paraIdB, paraIdA),
    devAccounts.bob,
  )
  await checkEvents(cannotSwapEvents, 'system').toMatchSnapshot('cannot swap two parathreads')

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
  await submitAndAdvanceBlock(client, client.api.tx.registrar.swap(paraIdA, paraIdB), devAccounts.alice)
  const pendingSwapChainThread = await client.api.query.registrar.pendingSwap(paraIdA)
  expect(pendingSwapChainThread.toString()).toBe(paraIdB.toString())

  // 3.2 Bob confirms: B ↔ A
  const chainThreadSwapConfirmEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.swap(paraIdB, paraIdA),
    devAccounts.bob,
  )

  await checkEvents(chainThreadSwapConfirmEvents, 'registrar')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('parachain parathread swap event')

  const eventsAfterChainThreadSwap = await client.api.query.system.events()
  const [chainThreadSwapEvent] = eventsAfterChainThreadSwap.filter(
    ({ event }) => event.section === 'registrar' && event.method === 'Swapped',
  )
  assert(client.api.events.registrar.Swapped.is(chainThreadSwapEvent.event))

  // 3.3 Asserting swap events
  expect(chainThreadSwapEvent.event.data[0].toString()).toBe(paraIdB.toString())
  expect(chainThreadSwapEvent.event.data[1].toString()).toBe(paraIdA.toString())

  // 4. Parachain and Parathread: A=Parathread (Alice), B=Parachain (Bob)
  await client.dev.setStorage({
    Registrar: {
      pendingSwap: [
        [[paraIdA], null],
        [[paraIdB], null],
      ],
    },
    Paras: {
      paraLifecycles: [
        [[paraIdA], 'Parathread'],
        [[paraIdB], 'Parachain'],
      ],
    },
  })

  // 4.1 Alice initiates: A ↔ B
  await submitAndAdvanceBlock(client, client.api.tx.registrar.swap(paraIdA, paraIdB), devAccounts.alice)
  const pendingSwapThreadChain = await client.api.query.registrar.pendingSwap(paraIdA)
  expect(pendingSwapThreadChain.toString()).toBe(paraIdB.toString())

  // 4.2 Bob confirms: B ↔ A
  const threadChainSwapConfirmEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.swap(paraIdB, paraIdA),
    devAccounts.bob,
  )

  await checkEvents(threadChainSwapConfirmEvents, 'registrar')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('parathread parachain swap event')

  const eventsAfterThreadChainSwap = await client.api.query.system.events()
  const [threadChainSwapEvent] = eventsAfterThreadChainSwap.filter(
    ({ event }) => event.section === 'registrar' && event.method === 'Swapped',
  )
  assert(client.api.events.registrar.Swapped.is(threadChainSwapEvent.event))

  // 4.3 Asserting swap events
  expect(threadChainSwapEvent.event.data[0].toString()).toBe(paraIdB.toString())
  expect(threadChainSwapEvent.event.data[1].toString()).toBe(paraIdA.toString())

  // 5: Parachain and Parachain confirmed swap
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

  // 5.1 Alice initiates: A ↔ B
  await submitAndAdvanceBlock(client, client.api.tx.registrar.swap(paraIdA, paraIdB), devAccounts.alice)
  const pendingSwapChainChain = await client.api.query.registrar.pendingSwap(paraIdA)
  expect(pendingSwapChainChain.toString()).toBe(paraIdB.toString())

  // 5.2 Bob confirms: B ↔ A
  const chainChainSwapConfirmEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.swap(paraIdB, paraIdA),
    devAccounts.bob,
  )

  // 5.3 Assert swap events
  await checkEvents(chainChainSwapConfirmEvents, 'registrar')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('parachain parachain swap event')

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
  const rootValidationCode = u8aToHex(
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02, 0x01, 0x00, 0x00]),
  )

  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  await forceRegisterParaViaRoot(client, chain, devAccounts.alice.address, paraId)

  // 1. Non-owner (Bob) cannot schedule a code upgrade
  const scheduleUpgradeBobEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.scheduleCodeUpgrade(paraId, newValidationCode),
    devAccounts.bob,
  )

  const unwantedFields = /Id/
  await checkEvents(scheduleUpgradeBobEvents, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('bob schedule code upgrade failed')

  // 2. Manager (Alice) can schedule a code upgrade
  const scheduleUpgradeAliceEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.scheduleCodeUpgrade(paraId, newValidationCode),
    devAccounts.alice,
  )

  await checkEvents(scheduleUpgradeAliceEvents, 'paras', 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('alice schedule code upgrade success')

  const eventsAfterAliceUpgrade = await client.api.query.system.events()
  const [codeUpgradeScheduledAlice] = eventsAfterAliceUpgrade.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CodeUpgradeScheduled',
  )
  assert(client.api.events.paras.CodeUpgradeScheduled.is(codeUpgradeScheduledAlice.event))
  expect(codeUpgradeScheduledAlice.event.data[0].toString()).toBe(paraId.toString())

  const futureCodeHashAlice = (await client.api.query.paras.futureCodeHash(paraId)) as Option<any>
  expect(futureCodeHashAlice.isSome).toBe(true)
  expect(futureCodeHashAlice.unwrap().toHex()).toBe(blake2AsHex(hexToU8a(newValidationCode)))

  const upgradeRestrictionAlice = (await client.api.query.paras.upgradeRestrictionSignal(paraId)) as Option<any>
  expect(upgradeRestrictionAlice.isSome).toBe(true)
  expect(upgradeRestrictionAlice.unwrap().isPresent).toBe(true)

  // 3. Lock the para via Root
  await addLockViaRoot(client, chain, paraId)

  const parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  expect(parasOption.unwrap().locked.toHuman()).toBe(true)

  // 4. Manager (Alice) cannot schedule a code upgrade when para is locked
  const scheduleUpgradeAliceLockedEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.scheduleCodeUpgrade(paraId, newValidationCode),
    devAccounts.alice,
  )

  await checkEvents(scheduleUpgradeAliceLockedEvents, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('alice locked schedule code upgrade failed')

  // 5. Root can schedule a code upgrade even when locked
  // Use a fresh para so the UpgradeRestrictionSignal from case 2 does not interfere.
  // Note: forceRegister does not update nextFreeParaId (only reserve() does), so paraId + 1 is safe.
  const paraIdB = paraId + 1
  await forceRegisterParaViaRoot(client, chain, devAccounts.alice.address, paraIdB)
  await addLockViaRoot(client, chain, paraIdB)

  const scheduleUpgradeRootTx = client.api.tx.registrar.scheduleCodeUpgrade(paraIdB, rootValidationCode)
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

  const eventsAfterRootUpgrade = await client.api.query.system.events()
  const dispatchedEvent = eventsAfterRootUpgrade.find(
    ({ event }) => event.section === 'scheduler' && event.method === 'Dispatched',
  )
  assert(dispatchedEvent !== undefined, 'Expected scheduler.Dispatched event')
  assert(client.api.events.scheduler.Dispatched.is(dispatchedEvent.event))
  expect(dispatchedEvent.event.data.result.isOk).toBe(true)

  const [codeUpgradeScheduledRoot] = eventsAfterRootUpgrade.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CodeUpgradeScheduled',
  )
  assert(client.api.events.paras.CodeUpgradeScheduled.is(codeUpgradeScheduledRoot.event))
  expect(codeUpgradeScheduledRoot.event.data[0].toString()).toBe(paraIdB.toString())

  const futureCodeHashRoot = (await client.api.query.paras.futureCodeHash(paraIdB)) as Option<any>
  expect(futureCodeHashRoot.isSome).toBe(true)
  expect(futureCodeHashRoot.unwrap().toHex()).toBe(blake2AsHex(hexToU8a(rootValidationCode)))

  const upgradeRestrictionRoot = (await client.api.query.paras.upgradeRestrictionSignal(paraIdB)) as Option<any>
  expect(upgradeRestrictionRoot.isSome).toBe(true)
  expect(upgradeRestrictionRoot.unwrap().isPresent).toBe(true)
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
 * 6. asserting that the para itself can set its own current head
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
  const setHeadBobEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.setCurrentHead(paraId, newHead),
    devAccounts.bob,
  )

  await checkEvents(setHeadBobEvents, 'system')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('bob set current head failed')

  // 2. Manager (Alice, unlocked) can set the current head
  const setHeadAliceEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.setCurrentHead(paraId, newHead),
    devAccounts.alice,
  )

  const headAfterAlice = await client.api.query.paras.heads(paraId)
  expect(headAfterAlice.toHex()).toBe(newHeadHex)

  await checkEvents(setHeadAliceEvents, 'paras')
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('alice set current head event')

  const eventsAfterAlice = await client.api.query.system.events()
  const [currentHeadUpdatedAlice] = eventsAfterAlice.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CurrentHeadUpdated',
  )
  assert(client.api.events.paras.CurrentHeadUpdated.is(currentHeadUpdatedAlice.event))
  expect(currentHeadUpdatedAlice.event.data[0].toString()).toBe(paraId.toString())

  // 3. Lock the para via Root
  await addLockViaRoot(client, chain, paraId)

  const parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  expect(parasOption.isSome).toBe(true)
  expect(parasOption.unwrap().locked.toHuman()).toBe(true)

  // 4. Manager (Alice, locked) cannot set the current head
  const updatedHeadRaw = new Uint8Array([0x04, 0x05, 0x06])
  const updatedHead = u8aToHex(updatedHeadRaw)
  const setHeadAliceLockedEvents = await submitAndAdvanceBlock(
    client,
    client.api.tx.registrar.setCurrentHead(paraId, updatedHead),
    devAccounts.alice,
  )

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

  await checkSystemEvents(client, { section: 'paras', method: 'CurrentHeadUpdated' })
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('root set current head event')

  const eventsAfterRoot = await client.api.query.system.events()
  const [currentHeadUpdatedRoot] = eventsAfterRoot.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CurrentHeadUpdated',
  )
  assert(client.api.events.paras.CurrentHeadUpdated.is(currentHeadUpdatedRoot.event))
  expect(currentHeadUpdatedRoot.event.data[0].toString()).toBe(paraId.toString())

  // 6. The para itself can set its own current head via a para origin
  const paraHeadRaw = new Uint8Array([0x07, 0x08, 0x09])
  const paraHead = u8aToHex(paraHeadRaw)
  const setHeadParaTx = client.api.tx.registrar.setCurrentHead(paraId, paraHead)
  await scheduleInlineCallWithOrigin(
    client,
    setHeadParaTx.method.toHex(),
    { ParachainsOrigin: { Parachain: paraId } },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const headAfterPara = await client.api.query.paras.heads(paraId)
  expect(headAfterPara.toHex()).toBe(u8aToHex(compactAddLength(paraHeadRaw)))

  await checkSystemEvents(client, { section: 'paras', method: 'CurrentHeadUpdated' })
    .redact({ removeKeys: /Id/ })
    .toMatchSnapshot('para set current head event')

  const eventsAfterPara = await client.api.query.system.events()
  const [currentHeadUpdatedPara] = eventsAfterPara.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CurrentHeadUpdated',
  )
  assert(client.api.events.paras.CurrentHeadUpdated.is(currentHeadUpdatedPara.event))
  expect(currentHeadUpdatedPara.event.data[0].toString()).toBe(paraId.toString())
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
        label: 'pallet registrar - reserve functions',
        testFn: async () => await paraReservingE2ETest(chain),
      },
      {
        kind: 'test',
        label: 'pallet registrar - register functions',
        testFn: async () => await paraRegisteringE2ETest(chain),
      },
      {
        kind: 'test',
        label: 'pallet registrar - deregister functions',
        testFn: async () => await paraDeregisteringE2ETest(chain),
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
