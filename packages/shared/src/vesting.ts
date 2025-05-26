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
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHub: Chain<TCustom, TInitStoragesPara>, addressEncoding: number) {
  const [ahClient] = await setupNetworks(assetHub)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const bobBalance = 100e10

  await ahClient.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: bobBalance } }]],
    },
  })

  const currBlockNumber = (await ahClient.api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber()

  const locked = ahClient.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const vestedTransferTx = ahClient.api.tx.vesting.vestedTransfer(bob.address, {
    perBlock,
    locked,
    startingBlock: currBlockNumber - 1,
  })
  const vestedTransferEvents = await sendTransaction(vestedTransferTx.signAsync(alice))

  await ahClient.dev.newBlock()

  await checkEvents(vestedTransferEvents, 'vesting').toMatchSnapshot('vest events')

  let events = await ahClient.api.query.system.events()

  const [ev1] = events.filter((record) => {
    const { event } = record
    return event.section === 'vesting' && event.method === 'VestingUpdated'
  })

  assert(ahClient.api.events.vesting.VestingUpdated.is(ev1.event))
  let vestingUpdatedEvent = ev1.event.data
  assert(vestingUpdatedEvent.account.eq(encodeAddress(bob.address, addressEncoding)))
  // The vesting schedule began before the vested transfer, so two blocks' worth of unvesting should be deducted from
  // the unvested amount in the event emitted in this block.
  assert(vestingUpdatedEvent.unvested.eq(locked - perBlock * 2))

  // The act of vesting does not change the `Vesting` storage item - to see how much was unlocked, events
  // must be queried.

  const vestingBalance = await ahClient.api.query.vesting.vesting(bob.address)
  assert(vestingBalance.isSome)
  assert(vestingBalance.unwrap().length === 1)
  assert(vestingBalance.unwrap()[0].locked.eq(locked))
  assert(vestingBalance.unwrap()[0].perBlock.eq(perBlock))
  assert(vestingBalance.unwrap()[0].startingBlock.eq(currBlockNumber - 1))

  // Check Bob's free and frozen balances

  let bobAccount = await ahClient.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toNumber()).toBe(bobBalance + locked)
  expect(bobAccount.data.frozen.toNumber()).toBe(vestingUpdatedEvent.unvested.toNumber())

  // As Alice, advance the vesting schedule in Bob's stead

  const vestOtherTx = ahClient.api.tx.vesting.vestOther(bob.address)
  const vestOtherEvents = await sendTransaction(vestOtherTx.signAsync(alice))

  await ahClient.dev.newBlock()

  await checkEvents(vestOtherEvents, 'vesting').toMatchSnapshot('vest other events')

  // Same as above regarding storage.

  const vestingBalance2 = await ahClient.api.query.vesting.vesting(bob.address)
  assert(vestingBalance2.eq(vestingBalance))

  events = await ahClient.api.query.system.events()

  const [ev2] = events.filter((record) => {
    const { event } = record
    return event.section === 'vesting' && event.method === 'VestingUpdated'
  })

  assert(ahClient.api.events.vesting.VestingUpdated.is(ev2.event))
  vestingUpdatedEvent = ev2.event.data
  assert(vestingUpdatedEvent.account.eq(encodeAddress(bob.address, addressEncoding)))
  assert(vestingUpdatedEvent.unvested.eq(locked - perBlock * 3))

  // Check Bob's free and frozen balances after Alice's vesting

  bobAccount = await ahClient.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toNumber()).toBe(bobBalance + locked)
  expect(bobAccount.data.frozen.toNumber()).toBe(vestingUpdatedEvent.unvested.toNumber())

  // As Bob advance his own vesting schedule

  const vestTx = ahClient.api.tx.vesting.vest()
  const vestEvents = await sendTransaction(vestTx.signAsync(bob))

  await ahClient.dev.newBlock()

  await checkEvents(vestEvents, 'vesting').toMatchSnapshot('vest events')

  events = await ahClient.api.query.system.events()

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

  assert(ahClient.api.events.vesting.VestingCompleted.is(ev3.event))
  const vestingCompletedEvent = ev3.event.data
  assert(vestingCompletedEvent.account.eq(encodeAddress(bob.address, addressEncoding)))

  const vestingBalance3 = await ahClient.api.query.vesting.vesting(bob.address)
  assert(vestingBalance3.isNone)

  // Final check to Bob's balance data

  assert(ahClient.api.events.balances.Withdraw.is(balEv.event))
  const balanceWithdrawalEvent = balEv.event.data
  assert(balanceWithdrawalEvent.who.eq(encodeAddress(bob.address, addressEncoding)))

  // Net of the fees from having called `vest` once, Bob's balance should the the vested amount, plus his initial
  // balance.
  bobAccount = await ahClient.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toNumber()).toBe(bobBalance + locked - balanceWithdrawalEvent.amount.toNumber())
  expect(bobAccount.data.frozen.toNumber()).toBe(0)
}

/**
 * Test that a force-vested transfer cannot be called with a signed origin.
 */
async function testForceVestedTransfer<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(assetHub: Chain<TCustom, TInitStoragesPara>) {
  const [ahClient] = await setupNetworks(assetHub)

  const alice = defaultAccountsSr25519.alice
  const charlie = defaultAccountsSr25519.charlie

  const currBlockNumber = (await ahClient.api.rpc.chain.getHeader()).number.toNumber()

  const locked = ahClient.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const forcedVestingTx = ahClient.api.tx.vesting.forceVestedTransfer(charlie.address, alice.address, {
    perBlock,
    locked,
    startingBlock: currBlockNumber,
  })

  const forcedVestingEvents = await sendTransaction(forcedVestingTx.signAsync(alice))

  await ahClient.dev.newBlock()

  await checkEvents(forcedVestingEvents, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'force vest events',
  )

  // Check the error for `BadOrigin`

  const events = await ahClient.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(ahClient.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isBadOrigin)

  // Check that no vesting balance was created.

  const vestingBalance = await ahClient.api.query.vesting.vesting(charlie.address)
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
  const charlie = defaultAccountsSr25519.charlie

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const vestingTx = client.api.tx.vesting.vestedTransfer(charlie.address, {
    perBlock,
    locked,
    startingBlock: currBlockNumber - 1,
  })
  await sendTransaction(vestingTx.signAsync(alice))

  await client.dev.newBlock()

  const forceRemoveVestingTx = client.api.tx.vesting.forceRemoveVestingSchedule(charlie.address, 0)
  await sendTransaction(forceRemoveVestingTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that no vesting schedule was removed.

  const vestingBalance = await client.api.query.vesting.vesting(charlie.address)
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
  const dave = defaultAccountsSr25519.dave

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const forceVestingTx = client.api.tx.vesting.forceVestedTransfer(alice.address, dave.address, {
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

  let bobAccount = await client.api.query.system.account(dave.address)
  expect(bobAccount.data.free.toNumber()).toBe(locked)
  expect(bobAccount.data.frozen.toNumber()).toBe(vestingUpdatedEvent.unvested.toNumber())

  // Check that a vesting schedule was forcibly created.

  const vestingBalance = await client.api.query.vesting.vesting(dave.address)
  assert(vestingBalance.isSome)
  assert(vestingBalance.unwrap().length === 1)
  assert(vestingBalance.unwrap()[0].locked.eq(locked))
  assert(vestingBalance.unwrap()[0].perBlock.eq(perBlock))
  assert(vestingBalance.unwrap()[0].startingBlock.eq(currBlockNumber - 1))

  // Forcibly remove the vesting schedule.

  const forceRemoveVestingTx = client.api.tx.vesting.forceRemoveVestingSchedule(dave.address, 0)
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
  const vestingBalance2 = await client.api.query.vesting.vesting(dave.address)
  assert(vestingBalance2.isNone)

  // Check that Bob's frozen balance is now 0, and that his free balance is equal to the initially vested amount.
  // In other words, forcible removal of vesting schedule does not make obliterate funds.

  bobAccount = await client.api.query.system.account(dave.address)
  expect(bobAccount.data.frozen.toNumber()).toBe(0)
  expect(bobAccount.data.free.toNumber()).toBe(locked)
}

/**
 * Test the merge of two vesting schedules.
 *
 * 1. Call `vesting.vestedTransfer` from Alice to Eve
 * 2. Call `vesting.vestedTransfer` from Alice to Eve, with different parameters, on the same block
 *   - the amount being vested, the per-block vesting amount, and the starting block are all different. This doesn't
 *     make the test complete, but depending on the values chosen, it can present interesting scenarios.
 * 3. Check that both vesting schedules are created
 * 4. Merge them
 * 5. Check that a single merged vesting schedule now exists for Eve
 */
async function testMergeVestingSchedules<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = defaultAccountsSr25519.alice
  const eve = defaultAccountsSr25519.eve

  await client.dev.setStorage({
    System: {
      account: [[[eve.address], { providers: 1, data: { free: 100e10 } }]],
    },
  })

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const initialBlockNumber = currBlockNumber

  const locked1 = client.api.consts.vesting.minVestedTransfer.toNumber() * 3
  // It is unlikely that the network's vesting amount is divisible by this prime number, so this should
  // be interpreted as `blocksToUnlock1 + 1`
  let blocksToUnlock1 = 13
  const perBlock1 = Math.floor(locked1 / blocksToUnlock1)
  blocksToUnlock1 += locked1 % blocksToUnlock1 ? 1 : 0

  const locked2 = locked1 * 2
  // Another prime number, so the same applies above.
  let blocksToUnlock2 = 19
  const perBlock2 = Math.floor(locked2 / blocksToUnlock2)
  blocksToUnlock2 += locked2 % blocksToUnlock2 ? 1 : 0

  const vestingTx1 = client.api.tx.vesting.vestedTransfer(eve.address, {
    perBlock: perBlock1,
    locked: locked1,
    startingBlock: currBlockNumber - 1,
  })

  const vestingTx2 = client.api.tx.vesting.vestedTransfer(eve.address, {
    perBlock: perBlock2,
    locked: locked2,
    startingBlock: currBlockNumber - 2,
  })

  let aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

  const vestingEvents1 = await sendTransaction(vestingTx1.signAsync(alice, { nonce: aliceNonce++ }))
  const vestingEvents2 = await sendTransaction(vestingTx2.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  currBlockNumber += 1

  await checkEvents(vestingEvents1, 'vesting').toMatchSnapshot('vesting events 1')
  await checkEvents(vestingEvents2, 'vesting').toMatchSnapshot('vesting events 2')

  const vestingBalance = await client.api.query.vesting.vesting(eve.address)
  assert(vestingBalance.isSome)
  expect(vestingBalance.unwrap().length).toBe(2)

  const mergeVestingTx = client.api.tx.vesting.mergeSchedules(0, 1)

  const mergeVestingEvents = await sendTransaction(mergeVestingTx.signAsync(eve))

  await client.dev.newBlock()

  currBlockNumber += 1

  await checkEvents(mergeVestingEvents, 'vesting').toMatchSnapshot('vesting schedules merger events')

  const vestingBalance2 = await client.api.query.vesting.vesting(eve.address)
  assert(vestingBalance2.isSome)
  expect(vestingBalance2.unwrap().length).toBe(1)

  const mergedVestingSchedule = vestingBalance2.unwrap()[0]
  // Merging schedules will unlock hitherto unvested funds, so the locked amount is the sum of the two schedules'
  // locked amounts, minus the sum of the two schedules' unvested amounts.
  const newLocked = locked1 + locked2 - (perBlock1 * 3 + perBlock2 * 4)
  expect(mergedVestingSchedule.locked.toNumber()).toBe(newLocked)

  // The remainder of the merged schedule's duration should be the longest of the two schedules.
  const blocksToUnlock = Math.max(blocksToUnlock1 - 3, blocksToUnlock2 - 4)
  const newPerBlock = Math.floor(newLocked / blocksToUnlock)
  expect(mergedVestingSchedule.perBlock.toNumber()).toBe(newPerBlock)
  expect(mergedVestingSchedule.startingBlock.toNumber()).toBe(
    Math.max(currBlockNumber, initialBlockNumber - 1, initialBlockNumber - 2),
  )
}

export function vestingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  relay: Chain<TCustom, TInitStoragesRelay>,
  assetHub: Chain<TCustom, TInitStoragesPara>,
  testConfig: { testSuiteName: string; addressEncoding: number },
) {
  describe(testConfig.testSuiteName, async () => {
    const [ahClient] = await setupNetworks(assetHub)

    const c = await ahClient.api.rpc.system.chain()
    // The vesting pallet will be disabled on Asset Hubs while the AHM is prepared/ongoing, so this ensures some tests
    // using `vesting.vestedTransfer` are only run on relay chains.
    // Furthermore, some tests use the `scheduler` pallet, which is not present on Asset Hubs, so they are put here
    // even if they do not include on vested transfers.
    if (!c.toString().includes('Asset Hub')) {
    }

    test('vesting schedule lifecycle', async () => {
      await testVestedTransfer(assetHub, testConfig.addressEncoding)
    })

    test('signed-origin forced removal of vesting schedule fails', async () => {
      await testForceRemoveVestedSchedule(ahClient)
    })

    test('forced vested transfer and forced removal of vesting schedule work', async () => {
      await testForceVestedTransferAndRemoval(ahClient)
    })

    test('test merger of two vesting schedules', async () => {
      await testMergeVestingSchedules(ahClient)
    })

    test('signed-origin force-vested transfer fails', async () => {
      await testForceVestedTransfer(ahClient)
    })
  })
}
