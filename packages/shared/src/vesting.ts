import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { DispatchError } from '@polkadot/types/interfaces'
import type { FrameSystemEventRecord } from '@polkadot/types/lookup'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import {
  blockProviderOffset,
  check,
  checkEvents,
  expectPjsEqual,
  getBlockNumber,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'

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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const setupFn = testConfig.setupNetworks || setupNetworks
  const [client] = await setupFn(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const bobBalance = 100e10

  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: bobBalance } }]],
    },
  })

  const currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = blockProviderOffset(testConfig)

  // On KAH, the minimum vested amount is not divisible by 8 (it isn't even even :) ), so this multiplication is needed.
  const locked = client.api.consts.vesting.minVestedTransfer.toNumber() * 8
  // Recall that asset hubs' block provider is nonlocal i.e. the relay's, and each AH block will unvest 2 relay blocks'
  // worth of funds.
  const perRelayBlock = Math.floor(locked / (4 * offset))

  const vestedTransferTx = client.api.tx.vesting.vestedTransfer(bob.address, {
    perBlock: perRelayBlock,
    locked,
    startingBlock: currBlockNumber - offset,
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
  expect(vestingUpdatedEvent.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  // The vesting schedule began before the vested transfer, so two blocks' worth of unvesting should be deducted from
  // the unvested amount in the event emitted in this block.
  expect(vestingUpdatedEvent.unvested.toNumber()).toBe(locked - perRelayBlock * 2 * offset)

  // The act of vesting does not change the `Vesting` storage item - to see how much was unlocked, events
  // must be queried.

  const vestingBalance = await client.api.query.vesting.vesting(bob.address)
  assert(vestingBalance.isSome)
  expect(vestingBalance.unwrap().length).toBe(1)
  expect(vestingBalance.unwrap()[0].locked.toNumber()).toBe(locked)
  expect(vestingBalance.unwrap()[0].perBlock.toNumber()).toBe(perRelayBlock)
  expect(vestingBalance.unwrap()[0].startingBlock.toNumber()).toBe(currBlockNumber - offset)

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
  expectPjsEqual(vestingBalance2, vestingBalance, 'Vesting balance should remain unchanged')

  events = await client.api.query.system.events()

  const [ev2] = events.filter((record) => {
    const { event } = record
    return event.section === 'vesting' && event.method === 'VestingUpdated'
  })

  assert(client.api.events.vesting.VestingUpdated.is(ev2.event))
  vestingUpdatedEvent = ev2.event.data
  expect(vestingUpdatedEvent.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(vestingUpdatedEvent.unvested.toNumber()).toBe(locked - perRelayBlock * 3 * offset)

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
  expect(vestingCompletedEvent.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))

  const vestingBalance3 = await client.api.query.vesting.vesting(bob.address)
  expect(vestingBalance3.isNone).toBe(true)

  // Final check to Bob's balance data

  assert(client.api.events.balances.Withdraw.is(balEv.event))
  const balanceWithdrawalEvent = balEv.event.data
  expect(balanceWithdrawalEvent.who.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))

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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const setupFn = testConfig.setupNetworks || setupNetworks
  const [client] = await setupFn(chain)

  const alice = defaultAccountsSr25519.alice
  const charlie = defaultAccountsSr25519.charlie

  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perRelayBlock = Math.floor(locked / 4)

  const forcedVestingTx = client.api.tx.vesting.forceVestedTransfer(charlie.address, alice.address, {
    perBlock: perRelayBlock,
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
  expect(dispatchError.isBadOrigin).toBe(true)

  // Check that no vesting balance was created.

  const vestingBalance = await client.api.query.vesting.vesting(charlie.address)
  expect(vestingBalance.isNone).toBe(true)
}

/**
 * Test that a vested schedule can't be removed via `force_remove_vesting_schedule` with a signed origin.
 */
async function testForceRemoveVestedSchedule<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const setupFn = testConfig.setupNetworks || setupNetworks
  const [client] = await setupFn(chain)

  const alice = defaultAccountsSr25519.alice
  const charlie = defaultAccountsSr25519.charlie

  const forceRemoveVestingTx = client.api.tx.vesting.forceRemoveVestingSchedule(charlie.address, 0)
  await sendTransaction(forceRemoveVestingTx.signAsync(alice))

  await client.dev.newBlock()

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
 * Test that forced vested transfers and removal of vesting schedules, with the root origin, work as expected.
 */
async function testForceVestedTransferAndRemoval<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const setupFn = testConfig.setupNetworks || setupNetworks
  const [client] = await setupFn(chain)

  const alice = defaultAccountsSr25519.alice
  const dave = defaultAccountsSr25519.dave

  const currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = blockProviderOffset(testConfig)

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perRelayBlock = Math.floor(locked / (4 * offset))

  const forceVestingTx = client.api.tx.vesting.forceVestedTransfer(alice.address, dave.address, {
    perBlock: perRelayBlock,
    locked,
    startingBlock: currBlockNumber - offset,
  })

  await scheduleInlineCallWithOrigin(
    client,
    forceVestingTx.method.toHex(),
    { system: 'Root' },
    testConfig.blockProvider,
  )

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
  expect(vestingBalance.unwrap().length).toBe(1)
  expect(vestingBalance.unwrap()[0].locked.toNumber()).toBe(locked)
  expect(vestingBalance.unwrap()[0].perBlock.toNumber()).toBe(perRelayBlock)
  expect(vestingBalance.unwrap()[0].startingBlock.toNumber()).toBe(currBlockNumber - offset)

  // Forcibly remove the vesting schedule.

  const forceRemoveVestingTx = client.api.tx.vesting.forceRemoveVestingSchedule(dave.address, 0)
  await scheduleInlineCallWithOrigin(
    client,
    forceRemoveVestingTx.method.toHex(),
    { system: 'Root' },
    testConfig.blockProvider,
  )

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
  expect(vestingBalance2.isNone).toBe(true)

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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const setupFn = testConfig.setupNetworks || setupNetworks
  const [client] = await setupFn(chain)

  const alice = defaultAccountsSr25519.alice
  const eve = defaultAccountsSr25519.eve

  await client.dev.setStorage({
    System: {
      account: [[[eve.address], { providers: 1, data: { free: 100e10 } }]],
    },
  })

  let currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const offset = blockProviderOffset(testConfig)
  const initialBlockNumber = currBlockNumber

  const locked1 = client.api.consts.vesting.minVestedTransfer.toNumber() * 3
  // It is unlikely that the network's vesting amount is divisible by this prime number, so this should
  // be interpreted as `blocksToUnlock1 + 1`
  let blocksToUnlock1 = 13
  const perBlock1 = Math.floor(locked1 / blocksToUnlock1)
  blocksToUnlock1 += locked1 % blocksToUnlock1 ? 1 : 0

  const locked2 = locked1 * 2
  // Another prime number, so the above applies here as well.
  let blocksToUnlock2 = 19
  const perBlock2 = Math.floor(locked2 / blocksToUnlock2)
  blocksToUnlock2 += locked2 % blocksToUnlock2 ? 1 : 0

  const vestingSchedule1 = {
    perBlock: perBlock1,
    locked: locked1,
    startingBlock: currBlockNumber - offset,
  }
  const vestingSchedule2 = {
    perBlock: perBlock2,
    locked: locked2,
    startingBlock: currBlockNumber - offset * 2,
  }

  // Perform vested transfers to Eve, to create two vesting schedules.

  const vestingTx1 = client.api.tx.vesting.vestedTransfer(eve.address, vestingSchedule1)
  const vestingTx2 = client.api.tx.vesting.vestedTransfer(eve.address, vestingSchedule2)

  let aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

  const vestingEvents1 = await sendTransaction(vestingTx1.signAsync(alice, { nonce: aliceNonce++ }))
  const vestingEvents2 = await sendTransaction(vestingTx2.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  await checkEvents(vestingEvents1, 'vesting').toMatchSnapshot('vesting events 1')
  await checkEvents(vestingEvents2, 'vesting').toMatchSnapshot('vesting events 2')

  currBlockNumber += offset

  // Check that two vesting schedules were created.

  const vestingBalance = await client.api.query.vesting.vesting(eve.address)
  assert(vestingBalance.isSome)
  expect(vestingBalance.unwrap().length).toBe(2)

  // Merge the two vesting schedules.

  const mergeVestingTx = client.api.tx.vesting.mergeSchedules(0, 1)

  const mergeVestingEvents = await sendTransaction(mergeVestingTx.signAsync(eve))

  await client.dev.newBlock()

  currBlockNumber += offset

  await checkEvents(mergeVestingEvents, 'vesting').toMatchSnapshot('vesting schedules merger events')

  const vestingBalance2 = await client.api.query.vesting.vesting(eve.address)
  assert(vestingBalance2.isSome)
  expect(vestingBalance2.unwrap().length).toBe(1)

  const mergedVestingSchedule = vestingBalance2.unwrap()[0]
  // Merging schedules will unlock hitherto unvested funds, so the locked amount is the sum of the two schedules'
  // locked amounts, minus the sum of the two schedules' unvested amounts.
  const newLocked = locked1 + locked2 - (perBlock1 * 3 * offset + perBlock2 * 4 * offset)
  expect(mergedVestingSchedule.locked.toNumber()).toBe(newLocked)

  // The remainder of the merged schedule's duration should be the longest of the two schedules.
  const blocksToUnlock = Math.max(blocksToUnlock1 - 3 * offset, blocksToUnlock2 - 4 * offset)
  const newPerBlock = Math.floor(newLocked / blocksToUnlock)
  expect(mergedVestingSchedule.perBlock.toNumber()).toBe(newPerBlock)
  expect(mergedVestingSchedule.startingBlock.toNumber()).toBe(
    Math.max(currBlockNumber, initialBlockNumber - offset, initialBlockNumber - offset * 2),
  )
}

/**
 * Test that vested transfers are filtered on the target chain.
 *
 * This applies to asset hubs in the lead-up to the AHM.
 */
async function testVestedTransferFiltered<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const locked = client.api.consts.vesting.minVestedTransfer.toNumber()
  const perBlock = Math.floor(locked / 4)

  const tx = client.api.tx.vesting.vestedTransfer(bob.address, {
    perBlock,
    locked,
    startingBlock: 0,
  })
  await sendTransaction(tx.signAsync(alice))

  await client.dev.newBlock()

  const sysEvents = await client.api.query.system.events()
  const failed = sysEvents.find((e) => e.event.section === 'system' && e.event.method === 'ExtrinsicFailed')
  expect(failed, 'Expected ExtrinsicFailed').toBeDefined()

  const dispatchErr = failed!.event.data[0] as DispatchError
  assert(dispatchErr.isModule)
  assert(client.api.errors.system.CallFiltered.is(dispatchErr.asModule))
}

/// Test that trying to merge nonexistent schedules fails with an appropriate error.
async function testMergeSchedulesNoSchedule<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const setupFn = testConfig.setupNetworks || setupNetworks
  const [client] = await setupFn(chain)

  const charlie = defaultAccountsSr25519.charlie

  await client.dev.setStorage({
    System: {
      account: [[[charlie.address], { providers: 1, data: { free: 100e10 } }]],
    },
  })

  const tx = client.api.tx.vesting.mergeSchedules(0, 1)
  const events = await sendTransaction(tx.signAsync(charlie))

  await client.dev.newBlock()

  // Expect an ExtrinsicFailed event, but NOT `CallFiltered`
  await checkEvents(events, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'merge schedules extrinsic failed',
  )

  const sysEvents = await client.api.query.system.events()
  const failed = sysEvents.find((e) => e.event.section === 'system' && e.event.method === 'ExtrinsicFailed')
  expect(failed, 'Expected ExtrinsicFailed').toBeDefined()

  const dispatchErr = failed!.event.data[0] as DispatchError
  expect(dispatchErr.isModule).toBe(true)
  // Ensure the failure is not due to call filtering
  assert(client.api.errors.vesting.NotVesting.is(dispatchErr.asModule))
}

export function fullVestingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'vesting schedule lifecycle',
        testFn: () => testVestedTransfer(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'signed-origin forced removal of vesting schedule fails',
        testFn: () => testForceRemoveVestedSchedule(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'signed-origin force-vested transfer fails',
        testFn: () => testForceVestedTransfer(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'forced vested transfer and forced removal of vesting schedule work',
        testFn: () => testForceVestedTransferAndRemoval(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'test merger of two vesting schedules',
        testFn: () => testMergeVestingSchedules(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'merging vesting schedules when none exist fails',
        testFn: () => testMergeSchedulesNoSchedule(chain, testConfig),
      },
    ],
  }
}

export function assetHubVestingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'vested transfer is filtered',
        testFn: () => testVestedTransferFiltered(chain),
      },
      {
        kind: 'test',
        label: 'signed-origin forced removal of vesting schedule fails',
        testFn: () => testForceRemoveVestedSchedule(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'signed-origin force-vested transfer fails',
        testFn: () => testForceVestedTransfer(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'attempt to merge when no vesting schedules exist fails',
        testFn: () => testMergeSchedulesNoSchedule(chain, testConfig),
      },
    ],
  }
}
