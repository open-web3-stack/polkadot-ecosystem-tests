import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'

import type { Option } from '@polkadot/types'
import type { ParaInfo } from '@polkadot/types/interfaces'
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

  const parasDeposit = client.api.consts.registrar.paraDeposit

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
  expect(paras.deposit.toString()).toBe(parasDeposit.toString())
  expect(paras.locked.isFalse).toBeFalsy()

  // Assert that the reserve balance is correct
  const aliceBalance = await client.api.query.system.account(devAccounts.alice.address)
  expect(aliceBalance.data.reserved.toString()).toBe(parasDeposit.toString())
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
