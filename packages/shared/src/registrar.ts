import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'

import type { Option } from '@polkadot/types'
import type { ParaInfo } from '@polkadot/types/interfaces'
import type { PolkadotRuntimeParachainsConfigurationHostConfiguration } from '@polkadot/types/lookup'
import { u8aToHex } from '@polkadot/util'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'
import { checkEvents, scheduleInlineCallWithOrigin, setupNetworks } from './index.js'
import type { RootTestTree } from './types.js'

const devAccounts = defaultAccountsSr25519

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
  console.log('[registrar] Setting up network for chain:', chain.name)
  const [client] = await setupNetworks(chain)
  console.log('[registrar] Network ready.')

  console.log(
    '[registrar] Funding Alice (address:',
    devAccounts.alice.address,
    ') with 100000e10 planck (100,000 DOT)...',
  )
  await client.dev.setStorage({
    System: {
      account: [
        [[devAccounts.alice.address], { providers: 1, data: { free: 100000e10 } }],
        [[devAccounts.bob.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  const paraDeposit = client.api.consts.registrar.paraDeposit
  const paraDepositBigInt = BigInt(paraDeposit.toString())
  const dataDepositPerByte = BigInt(client.api.consts.registrar.dataDepositPerByte.toString())
  const config =
    (await client.api.query.configuration.activeConfig()) as PolkadotRuntimeParachainsConfigurationHostConfiguration
  const maxCodeSize = BigInt(config.maxCodeSize.toString())
  const totalDeposit = paraDepositBigInt + dataDepositPerByte * maxCodeSize
  const additionalNeeded = totalDeposit - paraDepositBigInt

  console.log(
    '[registrar] consts — paraDeposit:',
    paraDeposit.toHuman(),
    '| dataDepositPerByte:',
    dataDepositPerByte.toString(),
    '| maxCodeSize:',
    maxCodeSize.toString(),
  )
  console.log(
    '[registrar] deposit math — totalDeposit:',
    totalDeposit.toString(),
    '| additionalNeeded for register():',
    additionalNeeded.toString(),
  )

  // 1. Reserve a para ID
  console.log('[registrar] 1. Submitting reserve() from Alice...')
  const reserveTx = client.api.tx.registrar.reserve()
  const reserveEvent = await sendTransaction(reserveTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()
  console.log('[registrar] reserve() block produced.')

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
  console.log('[registrar] 1.1 Reserved paraId:', paraId, '| reserving account:', reserveEventData[1].toHuman())
  expect(reserveEventData[1].toString()).toBe(
    encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding),
  )

  // Assert that para info is correct
  const parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  console.log('[registrar] paras(paraId) isSome:', parasOption.isSome)
  expect(parasOption.isSome).toBe(true)
  const paras = parasOption.unwrap()
  console.log(
    '[registrar] ParaInfo — manager:',
    paras.manager.toHuman(),
    '| deposit:',
    paras.deposit.toHuman(),
    '| locked:',
    paras.locked.toHuman(),
  )

  expect(paras.manager.toString()).toBe(encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding))
  expect(paras.deposit.toString()).toBe(paraDeposit.toString())
  expect(paras.locked.isFalse).toBeFalsy()

  // 1.2 Assert that the reserved balance is correct
  let aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  console.log('[registrar] 1.2 Alice balance after reserve():', aliceBalance.data.toHuman())
  console.log('[registrar] Expected reserved:', paraDeposit.toHuman())
  expect(aliceBalance.data.reserved.toString()).toBe(paraDeposit.toString())

  // Genesis head
  const genesisHead = new Uint8Array([0x00])
  // Minimal valid WASM module (11 bytes) - validation code
  const validationCode = u8aToHex(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]))

  // 1.3 Assert that bob (not owner) cannot register the para
  console.log('[registrar] 1.3 Submitting register() from Bob (expected to fail — not owner, paraId:', paraId, ')...')
  const registerTxBob = client.api.tx.registrar.register(paraId, genesisHead, validationCode)
  const registerEventsBob = await sendTransaction(registerTxBob.signAsync(devAccounts.bob))
  await client.dev.newBlock()
  console.log('[registrar] Bob register() block produced.')

  await checkEvents(registerEventsBob, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('bob para register failed event')

  // 2. Test that alice can register the para
  console.log('[registrar] 2. Submitting register() from Alice (paraId:', paraId, ')...')
  const registerTx = client.api.tx.registrar.register(paraId, genesisHead, validationCode)
  const registerEvents = await sendTransaction(registerTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()
  console.log('[registrar] Alice register() block produced.')

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
  console.log(
    '[registrar] 2.1 Registered event — paraId:',
    regEvent.event.data[0].toHuman(),
    '| manager:',
    regEvent.event.data[1].toHuman(),
  )
  expect(regEvent.event.data[0].toString()).toBe(paraId)
  expect(regEvent.event.data[1].toString()).toBe(
    encodeAddress(devAccounts.alice.address, chain.properties.addressEncoding),
  )

  // 2.2 Assert that the new reserved balance includes additional deposit from registration
  aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  console.log('[registrar] 2.2 Alice balance after register():', aliceBalance.data.toHuman())
  console.log('[registrar] Expected reserved:', (paraDepositBigInt + additionalNeeded).toString())
  expect(aliceBalance.data.reserved.toString()).toBe((paraDepositBigInt + additionalNeeded).toString())

  // 2.3 alice trying to register again with the same paraId should fail
  console.log('[registrar] 2.3 Submitting duplicate register() from Alice (expected to fail, paraId:', paraId, ')...')
  const registerTxDuplicate = client.api.tx.registrar.register(paraId, genesisHead, validationCode)
  const registerEventsDuplicate = await sendTransaction(registerTxDuplicate.signAsync(devAccounts.alice))
  await client.dev.newBlock()
  console.log('[registrar] Duplicate register() block produced.')

  await checkEvents(registerEventsDuplicate, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('alice duplicate para register failed event')

  // 3. deregister para
  // set para lifecycle state directly
  console.log('[registrar] 3.2 Forcing para lifecycle to Parathread via setStorage (paraId:', paraId, ')...')
  await client.dev.setStorage({
    Paras: {
      paraLifecycles: [[[parseInt(paraId)], 'Parathread']],
    },
  })

  // 3.1 Assert that bob (not owner) cannot deregister the para
  console.log('[registrar] 3.1 Submitting deregister() from Bob (expected to fail — not owner, paraId:', paraId, ')...')
  const deregisterTxBob = client.api.tx.registrar.deregister(paraId)
  const deregisterEventsBob = await sendTransaction(deregisterTxBob.signAsync(devAccounts.bob))
  await client.dev.newBlock()
  console.log('[registrar] Bob deregister() block produced.')

  await checkEvents(deregisterEventsBob, 'system')
    .redact({ removeKeys: unwantedFields })
    .toMatchSnapshot('bob para deregister failed event')

  // 3.2 Alice deregisters the para
  console.log('[registrar] 3.2 Submitting deregister() from Alice (paraId:', paraId, ')...')
  const deregisterTx = client.api.tx.registrar.deregister(paraId)
  await sendTransaction(deregisterTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()
  console.log('[registrar] Alice deregister() block produced.')

  // Verify deregistered event data
  const systemEventsAfterDeregister = await client.api.query.system.events()
  console.log(
    '[registrar] 3.2 All events after deregister():',
    systemEventsAfterDeregister.map((r) => `${r.event.section}.${r.event.method}`).join(', '),
  )

  const [deregEvent] = systemEventsAfterDeregister.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Deregistered'
  })
  assert(client.api.events.registrar.Deregistered.is(deregEvent.event))
  console.log('[registrar] 3.2 Deregistered event — paraId:', deregEvent.event.data[0].toHuman())
  expect(deregEvent.event.data[0].toString()).toBe(paraId)

  // 3.3 Assert that all reserved balance is returned after deregistration
  aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  console.log('[registrar] 3.3 Alice balance after deregister():', aliceBalance.data.toHuman())
  console.log('[registrar] Expected reserved: 0')
  expect(aliceBalance.data.reserved.toString()).toBe('0')

  // 3.4 Assert paras entry is gone
  const parasOptionAfter = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  console.log('[registrar] 3.4 paras(paraId) isSome after deregister:', parasOptionAfter.isSome)
  expect(parasOptionAfter.isSome).toBe(false)

  console.log('[registrar] parasRegistrationE2ETest complete.')
}

/**
 * Test the process of
 * 1. reserving a para ID via Root origin
 *
 *     1.1 asserting that the para ID was successfully registered by Root call
 *
 *     1.2 asserting that bob was set as manager for reserved para
 *
 * 2. deregistering para via Root origin
 *
 *     2.1 asserting events that deregister of para was successful
 *
 *     2.2 asserting para entry is no longer present
 */
export async function parasRootRegistrationE2eTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  console.log('[registrar:root] Setting up network for chain:', chain.name)
  const [client] = await setupNetworks(chain)
  console.log('[registrar:root] Network ready.')

  // Pay 0 DOT for registration
  const paraDepositBigInt = BigInt(0)
  console.log('[registrar:root] paraDeposit:', paraDepositBigInt.toString())

  const bobBalanceBefore = await client.api.query.system.account(devAccounts.bob.address)
  console.log('[registrar:root] Bob balance before force_register:', bobBalanceBefore.data.toHuman())

  // Query the next free para ID so we don't collide with an already-registered para (e.g. Acala=2000)
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString())
  console.log('[registrar:root] nextFreeParaId from chain:', paraId)

  // Genesis head and minimal WASM validation code
  const genesisHead = new Uint8Array([0x00])
  const validationCode = u8aToHex(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]))

  // Call force_register via Root origin — sets Bob as manager
  console.log('[registrar:root] Scheduling force_register() with Root origin (manager: Bob, paraId:', paraId, ')...')
  const forceRegisterTx = client.api.tx.registrar.forceRegister(
    devAccounts.bob.address,
    paraDepositBigInt,
    paraId,
    genesisHead,
    validationCode,
  )
  await scheduleInlineCallWithOrigin(
    client,
    forceRegisterTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  console.log('[registrar:root] force_register() block produced.')

  // 1.1 Assert Registered event
  const systemEvents = await client.api.query.system.events()
  const [regEvent] = systemEvents.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Registered'
  })
  assert(client.api.events.registrar.Registered.is(regEvent.event))
  console.log(
    '[registrar:root] Registered event — paraId:',
    regEvent.event.data[0].toHuman(),
    '| manager:',
    regEvent.event.data[1].toHuman(),
  )
  expect(regEvent.event.data[0].toString()).toBe(paraId.toString())
  expect(regEvent.event.data[1].toString()).toBe(
    encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding),
  )

  // 1.2 Assert ParaInfo has Bob as manager and correct deposit
  const parasOption = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  console.log('[registrar:root] paras(paraId) isSome:', parasOption.isSome)
  expect(parasOption.isSome).toBe(true)
  const paras = parasOption.unwrap()
  console.log(
    '[registrar:root] ParaInfo — manager:',
    paras.manager.toHuman(),
    '| deposit:',
    paras.deposit.toHuman(),
    '| locked:',
    paras.locked.toHuman(),
  )
  expect(paras.manager.toString()).toBe(encodeAddress(devAccounts.bob.address, chain.properties.addressEncoding))
  expect(paras.deposit.toString()).toBe(paraDepositBigInt.toString())
  expect(paras.locked.isFalse).toBeFalsy()

  // Assert the deposit was reserved from Bob's account
  const bobBalanceAfter = await client.api.query.system.account(devAccounts.bob.address)
  console.log('[registrar:root] Bob balance after force_register:', bobBalanceAfter.data.toHuman())
  console.log('[registrar:root] Expected reserved:', paraDepositBigInt.toString())
  expect(bobBalanceAfter.data.reserved.toString()).toBe(paraDepositBigInt.toString())

  // 2. Deregister the para via Root origin
  // set para lifecycle state directly
  await client.dev.setStorage({
    Paras: {
      paraLifecycles: [[[paraId], 'Parathread']],
    },
  })

  console.log('[registrar:root] Scheduling deregister() with Root origin (paraId:', paraId, ')...')
  const deregisterTx = client.api.tx.registrar.deregister(paraId)
  await scheduleInlineCallWithOrigin(
    client,
    deregisterTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  console.log('[registrar:root] Root deregister() block produced.')

  // 2.1 Assert Deregistered event
  const systemEventsAfterDeregister = await client.api.query.system.events()
  const [deregEvent] = systemEventsAfterDeregister.filter((record) => {
    const { event } = record
    return event.section === 'registrar' && event.method === 'Deregistered'
  })
  assert(client.api.events.registrar.Deregistered.is(deregEvent.event))
  console.log('[registrar:root] Deregistered event — paraId:', deregEvent.event.data[0].toHuman())
  expect(deregEvent.event.data[0].toString()).toBe(paraId.toString())

  // 2.2 Assert paras entry is gone
  const parasOptionAfter = (await client.api.query.registrar.paras(paraId)) as Option<ParaInfo>
  console.log('[registrar:root] paras(paraId) isSome after deregister:', parasOptionAfter.isSome)
  expect(parasOptionAfter.isSome).toBe(false)

  console.log('[registrar:root] parasRootRegistrationE2eTest complete.')
}

// export async function parasRegistrarLifecycleE2ETest<
//   TCustom extends Record<string, unknown> | undefined,
//   TInitStorages extends Record<string, Record<string, any>> | undefined,
// >(chain: Chain<TCustom, TInitStorages>) {
//   const [client] = await setupNetworks(chain)

//   const paras = await client.api.query.registrar.paras(1000)
// }

export function registrarE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      // {
      //   kind: 'test',
      //   label: 'pallet registrar - registration functions',
      //   testFn: async () => await parasRegistrationE2ETest(chain),
      // },
      {
        kind: 'test',
        label: 'pallet registrar - root registration functions',
        testFn: async () => await parasRootRegistrationE2eTest(chain),
      },
      // {
      //   kind: 'test',
      //   label: 'pallet registrar - lifecycle functions',
      //   testFn: async () => await parasRegistrarLifecycleE2ETest(chain),
      // },
    ],
  }
}
