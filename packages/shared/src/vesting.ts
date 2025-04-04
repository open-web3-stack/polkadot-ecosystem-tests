import { encodeAddress } from '@polkadot/util-crypto'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'
import { check, checkEvents, scheduleInlineCallWithOrigin } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import type { FrameSystemEventRecord } from '@polkadot/types/lookup'
import { assert, describe, expect, test } from 'vitest'

/**
 * Test that a vested transfer works as expected.
 *
 * 1. Vested transfer from Alice to Bob, set to begin vesting in the block prior to the transfer
 * 2. Alice vests Bob in his stead
 * 3. Bob calls `vest` himself as the vesting schedule is set to complete
 * 4. The vesting schedule is removed from storage
 * 5. Bob's balance is checked to be his initial balance plus the vested amount, minus any transaction fees
 */
async function testVestedTransfer<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, addressEncoding: number) {
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const bobBalance = 100e10

  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: bobBalance } }]],
    },
  })

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const vestedTransferTx = client.api.tx.vesting.vestedTransfer(bob.address, {
    perBlock,
    locked,
    startingBlock: currBlockNumber - 1,
  })
  const vestedTransferEvents = await sendTransaction(vestedTransferTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(vestedTransferEvents, 'vesting').toMatchSnapshot('vest events')

  let events = await client.api.query.system.events()

  const [ev1] = events.filter((record) => {
    const { event } = record
    return event.section === 'vesting' && event.method === 'VestingUpdated'
  })

  assert(client.api.events.vesting.VestingUpdated.is(ev1.event))
  let vestingUpdatedEvent = ev1.event.data
  assert(vestingUpdatedEvent.account.eq(encodeAddress(bob.address, addressEncoding)))
  // The vesting schedule began before the vested transfer, so two blocks' worth of unvesting should be deducted from
  // the unvested amount in the event emitted in this block.
  assert(vestingUpdatedEvent.unvested.eq(locked - perBlock * 2))

  // The act of vesting does not change the `Vesting` storage item - to see how much was unlocked, events
  // must be queried.

  const vestingBalance = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance.isSome)
  assert(vestingBalance.unwrap().length === 1)
  assert(vestingBalance.unwrap()[0].locked.eq(locked))
  assert(vestingBalance.unwrap()[0].perBlock.eq(perBlock))
  assert(vestingBalance.unwrap()[0].startingBlock.eq(currBlockNumber - 1))

  // Check Bob's free and frozen balances

  let bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toNumber()).toBe(bobBalance + locked)
  expect(bobAccount.data.frozen.toNumber()).toBe(vestingUpdatedEvent.unvested.toNumber())

  // As Alice, advance the vesting schedule in Bob's stead

  const vestOtherTx = client.api.tx.vesting.vestOther(bob.address)
  const vestOtherEvents = await sendTransaction(vestOtherTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(vestOtherEvents, 'vesting').toMatchSnapshot('vest other events')

  // Same as above regarding storage.

  const vestingBalance2 = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance2.eq(vestingBalance))

  events = await client.api.query.system.events()

  const [ev2] = events.filter((record) => {
    const { event } = record
    return event.section === 'vesting' && event.method === 'VestingUpdated'
  })

  assert(client.api.events.vesting.VestingUpdated.is(ev2.event))
  vestingUpdatedEvent = ev2.event.data
  assert(vestingUpdatedEvent.account.eq(encodeAddress(bob.address, addressEncoding)))
  assert(vestingUpdatedEvent.unvested.eq(locked - perBlock * 3))

  // Check Bob's free and frozen balances after Alice's vesting

  bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toNumber()).toBe(bobBalance + locked)
  expect(bobAccount.data.frozen.toNumber()).toBe(vestingUpdatedEvent.unvested.toNumber())

  // As Bob advance his own vesting schedule

  const vestTx = client.api.tx.vesting.vest()
  const vestEvents = await sendTransaction(vestTx.signAsync(bob))

  await client.dev.newBlock()

  await checkEvents(vestEvents, 'vesting').toMatchSnapshot('vest events')

  events = await client.api.query.system.events()

  const vestingEvents: FrameSystemEventRecord[] = []
  const balanceWithdrawalEvents: FrameSystemEventRecord[] = []

  events.forEach((record) => {
    const { event } = record
    if (event.section === 'vesting') {
      vestingEvents.push(record)
    } else if (event.section === 'balances' && event.method === 'Withdraw') {
      balanceWithdrawalEvents.push(record)
    }
  })

  // There should only have been one vesting event and one balance withdrawal event.
  const [ev3] = vestingEvents
  const [balEv] = balanceWithdrawalEvents

  assert(client.api.events.vesting.VestingCompleted.is(ev3.event))
  const vestingCompletedEvent = ev3.event.data
  assert(vestingCompletedEvent.account.eq(encodeAddress(bob.address, addressEncoding)))

  const vestingBalance3 = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance3.isNone)

  // Final check to Bob's balance data

  assert(client.api.events.balances.Withdraw.is(balEv.event))
  const balanceWithdrawalEvent = balEv.event.data
  assert(balanceWithdrawalEvent.who.eq(encodeAddress(bob.address, addressEncoding)))

  // Net of the fees from having called `vest` once, Bob's balance should the the vested amount, plus his initial
  // balance.
  bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toNumber()).toBe(bobBalance + locked - balanceWithdrawalEvent.amount.toNumber())
  expect(bobAccount.data.frozen.toNumber()).toBe(0)
}

/**
 * Test that a force-vested transfer cannot be called with a signed origin.
 */
async function testForceVestedTransfer<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const forcedVestingTx = client.api.tx.vesting.forceVestedTransfer(bob.address, alice.address, {
    perBlock,
    locked,
    startingBlock: currBlockNumber,
  })

  const forcedVestingEvents = await sendTransaction(forcedVestingTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(forcedVestingEvents, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'force vest events',
  )

  // Check the error for `BadOrigin`

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isBadOrigin)

  // Check that no vesting balance was created.

  const vestingBalance = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance.isNone)
}

/**
 * Test that a vested schedule can't be removed via `force_remove_vesting_schedule` with a signed origin.
 */
async function testForceRemoveVestedSchedule<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const vestingTx = client.api.tx.vesting.vestedTransfer(bob.address, {
    perBlock,
    locked,
    startingBlock: currBlockNumber - 1,
  })
  await sendTransaction(vestingTx.signAsync(alice))

  await client.dev.newBlock()

  const forceRemoveVestingTx = client.api.tx.vesting.forceRemoveVestingSchedule(bob.address, 0)
  await sendTransaction(forceRemoveVestingTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that no vesting schedule was removed.

  const vestingBalance = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance.isSome)

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
 * Test that forced vested transfers and removal of vesting schedules, with the root origin, work as expected.
 */
async function testForceVestedTransferAndRemoval<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const forceVestingTx = client.api.tx.vesting.forceVestedTransfer(alice.address, bob.address, {
    perBlock,
    locked,
    startingBlock: currBlockNumber - 1,
  })

  scheduleInlineCallWithOrigin(client, forceVestingTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  // Forced vested transfer emit events, as expected

  let events = await client.api.query.system.events()

  const [evV] = events.filter((record) => {
    const { event } = record
    return event.section === 'vesting' && event.method === 'VestingUpdated'
  })

  assert(client.api.events.vesting.VestingUpdated.is(evV.event))
  const vestingUpdatedEvent = evV.event.data
  await check(vestingUpdatedEvent).toMatchSnapshot('forced vested transfer event')

  // Check that Bob's frozen balance corresponds to the as-yet unvested amount in the event

  let bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toNumber()).toBe(locked)
  expect(bobAccount.data.frozen.toNumber()).toBe(vestingUpdatedEvent.unvested.toNumber())

  // Check that a vesting schedule was forcibly created.

  const vestingBalance = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance.isSome)
  assert(vestingBalance.unwrap().length === 1)
  assert(vestingBalance.unwrap()[0].locked.eq(locked))
  assert(vestingBalance.unwrap()[0].perBlock.eq(perBlock))
  assert(vestingBalance.unwrap()[0].startingBlock.eq(currBlockNumber - 1))

  // Forcibly remove the vesting schedule.

  const forceRemoveVestingTx = client.api.tx.vesting.forceRemoveVestingSchedule(bob.address, 0)
  scheduleInlineCallWithOrigin(client, forceRemoveVestingTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  events = await client.api.query.system.events()

  const [evF] = events.filter((record) => {
    const { event } = record
    return event.section === 'vesting' && event.method === 'VestingCompleted'
  })

  assert(client.api.events.vesting.VestingCompleted.is(evF.event))
  const vestingRemoved = evF.event.data
  await check(vestingRemoved).toMatchSnapshot('forced vesting removal event')

  // Check that the vesting schedule was removed.
  const vestingBalance2 = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance2.isNone)

  // Check that Bob's frozen balance is now 0, and that his free balance is equal to the initially vested amount.
  // In other words, forcible removal of vesting schedule does not make obliterate funds.

  bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.frozen.toNumber()).toBe(0)
  expect(bobAccount.data.free.toNumber()).toBe(locked)
}

export function vestingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, async () => {
    const [client] = await setupNetworks(chain)

    // Hack: vesting pallet will be disabled on Asset Hubs, so this is a way of ensuring the test is only
    // run on relay chains.
    if (client.api.query.scheduler) {
      test('vesting schedule lifecycle', async () => {
        await testVestedTransfer(client, testConfig.addressEncoding)
      })
    }

    test('signed-origin force-vested transfer fails', async () => {
      await testForceVestedTransfer(client)
    })

    test('signed-origin forced removal of vesting schedule fails', async () => {
      await testForceRemoveVestedSchedule(client)
    })

    // Asset Hubs do not have the scheduler pallet, so for them, the test is skipped.
    if (client.api.query.scheduler) {
      test('forced vested transfer and forced removal of vesting schedule work', async () => {
        await testForceVestedTransferAndRemoval(client)
      })
    }
  })
}
