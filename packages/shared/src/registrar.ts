import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'

import type { Option } from '@polkadot/types'
import type { ParaInfo } from '@polkadot/types/interfaces'
import type { PolkadotRuntimeParachainsConfigurationHostConfiguration } from '@polkadot/types/lookup'
import { u8aToHex } from '@polkadot/util'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'
import { checkEvents, setupNetworks } from './index.js'
import type { RootTestTree } from './types.js'

const devAccounts = defaultAccountsSr25519

export async function parasRegistrationE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  await client.dev.setStorage({
    System: {
      account: [[[devAccounts.alice.address], { providers: 1, data: { free: 100000e10 } }]],
    },
  })

  const paraDeposit = client.api.consts.registrar.paraDeposit

  // Reserve a para ID
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
  expect(paras.locked.isFalse).toBeFalsy()

  // Assert that the reserved balance is correct
  let aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  console.log('aliceBalance', aliceBalance.toHuman())
  expect(aliceBalance.data.reserved.toString()).toBe(paraDeposit.toString())

  const paraDepositBigInt = BigInt(client.api.consts.registrar.paraDeposit.toString())
  const dataDepositPerByte = BigInt(client.api.consts.registrar.dataDepositPerByte.toString())
  const config =
    (await client.api.query.configuration.activeConfig()) as PolkadotRuntimeParachainsConfigurationHostConfiguration
  const maxCodeSize = BigInt(config.maxCodeSize.toString())

  const totalDeposit = paraDepositBigInt + dataDepositPerByte * maxCodeSize

  // reserve() already locked paraDeposit, so register() only needs the delta
  const alreadyReserved = paraDepositBigInt // if reserve() was already called
  const additionalNeeded = totalDeposit - alreadyReserved

  console.log('totalDeposit:      ', totalDeposit.toString())
  console.log('additionalNeeded:  ', additionalNeeded.toString())

  // Register the para with genesis head and validation code
  const genesisHead = new Uint8Array([0x00])
  // Minimal valid WASM module (11 bytes)
  const validationCode = u8aToHex(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]))
  const registerTx = client.api.tx.registrar.register(paraId, genesisHead, validationCode)
  const registerEvents = await sendTransaction(registerTx.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  const registerSystemEvents = await client.api.query.system.events()
  const failedEvent = registerSystemEvents.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  if (failedEvent && client.api.events.system.ExtrinsicFailed.is(failedEvent.event)) {
    const { dispatchError } = failedEvent.event.data
    if (dispatchError.isModule) {
      const decoded = client.api.registry.findMetaError(dispatchError.asModule)
      console.log('ExtrinsicFailed:', decoded.section, decoded.method, decoded.docs)
    } else {
      console.log('ExtrinsicFailed:', dispatchError.toHuman())
    }
  }

  // Assert register events
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

  // Assert that the new reserved balance includes additional deposit from registration
  aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  console.log('aliceBalance after register', aliceBalance.toHuman())
  expect(aliceBalance.data.reserved.toString()).toBe((paraDepositBigInt + additionalNeeded).toString())
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
      {
        kind: 'describe',
        label: testConfig.testSuiteName,
        children: [
          {
            kind: 'test',
            label: 'pallet registrar - registration functions',
            testFn: async () => await parasRegistrationE2ETest(chain),
          },
          // {
          //   kind: 'test',
          //   label: 'pallet registrar - lifecycle functions',
          //   testFn: async () => await parasRegistrarLifecycleE2ETest(chain),
          // },
        ],
      },
    ],
  }
}
