import { sendTransaction } from '@acala-network/chopsticks-testing'
import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, describe, expect, test } from 'vitest'
import { checkEvents } from './helpers/index.js'

/// -------
/// Helpers
/// -------

/// -------
/// -------
/// -------

/**
 * Test basic multisig creation and execution.
 *
 * 1. Alice creates a 2-of-3 multisig operation with Bob and Charlie as other signatories
 *   - the operation is to send funds to Dave
 * 2. Verify that Alice makes a deposit for the multisig creation
 * 3. Bob approves the multisig operation (with correct parameters passed to `multisig.asMulti`)
 * 4. Verify that the operation was performed
 */
async function basicMultisigTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave

  // Fund test accounts
  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: 1000e10 } }]],
    },
  })

  // Create a simple call to transfer funds to Dave from the 2-of-3 multisig
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob and Charlie (threshold: 2)
  const threshold = 2
  const otherSignatories = [bob.address, charlie.address].sort()
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit

  // First and last approvals require encoded call; the following approvals - the non-final ones - require a hash.
  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's multisig creation deposit was reserved
  const multisigBaseDeposit = client.api.consts.multisig.depositBase
  const multisigDepositFactor = client.api.consts.multisig.depositFactor
  let aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.reserved.toNumber(), 'Alice should have reserved funds for multisig deposit').toBe(
    multisigBaseDeposit.add(multisigDepositFactor.muln(threshold)).toNumber(),
  )

  // Check the multisig creation event (and extract multisig account address)

  let events = await client.api.query.system.events()

  const [multisigEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })

  assert(client.api.events.multisig.NewMultisig.is(multisigEvent.event))
  const multisigExtrinsicIndex = multisigEvent.phase.asApplyExtrinsic.toNumber()

  const newMultisigEventData = multisigEvent.event.data
  expect(newMultisigEventData.approving.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  const multisigAddress = newMultisigEventData.multisig
  const multisigCallHash = newMultisigEventData.callHash

  // Funds the multisig account to execute the call
  const multisigFunds = 101e10
  await client.dev.setStorage({
    System: {
      account: [[[multisigAddress], { providers: 1, data: { free: multisigFunds } }]],
    },
  })

  // Approve the multisig call. This is the final approval, so `multisig.asMulti` is used.

  const finalApprovalTx = client.api.tx.multisig.asMulti(
    threshold,
    [alice.address, charlie.address].sort(),
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    maxWeight,
  )

  const finalApprovalEvents = await sendTransaction(finalApprovalTx.signAsync(bob))

  // Before the multisig executes, check that Dave has no funds, just for certainty.
  let daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have no funds before multisig executes').toBe(0)

  await client.dev.newBlock()

  await checkEvents(finalApprovalEvents, 'multisig').toMatchSnapshot('events when Alice approves multisig call')

  // Dave should now have some funds
  daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have some funds after multisig executes').toBe(transferAmount)

  // Check that Bob was not required to deposit anything, as he was not the first signatory.
  const bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.reserved.toNumber(), 'Bob should have no reserved funds').toBe(0)
  // Check that Alice's deposit is gone
  aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.reserved.toNumber(), "Alice's deposit should have been refunded").toBe(0)

  // Check that the multisig account has no funds
  const multisigAccount = await client.api.query.system.account(multisigAddress)
  expect(multisigAccount.data.free.toNumber(), 'Multisig account should have no funds after multisig executes').toBe(
    multisigFunds - transferAmount,
  )

  // Check the emitted event
  events = await client.api.query.system.events()
  const [multisigExecutedEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })
  assert(client.api.events.multisig.MultisigExecuted.is(multisigExecutedEvent.event))
  const multisigExecutedEventData = multisigExecutedEvent.event.data
  expect(multisigExecutedEventData.approving.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(multisigExecutedEventData.timepoint.height.toNumber()).toBe(currBlockNumber + 1)
  expect(multisigExecutedEventData.multisig.toString()).toBe(multisigAddress.toString())
  expect(multisigExecutedEventData.callHash.toString()).toBe(multisigCallHash.toString())
}

/**
 * Test multisig cancellation.
 *
 * 1. Alice creates a 2-of-3 multisig operation with Bob and Charlie as other signatories
 *   - the operation is to send funds to Dave
 * 2. Verify that Alice makes a deposit for the multisig creation
 * 3. Alice cancels the multisig operation using `multisig.cancelAsMulti`
 * 4. Verify that the operation was cancelled, and the deposit was refunded
 */
async function multisigCancellationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave

  // Fund test accounts
  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: 1000e10 } }]],
    },
  })

  // Create a simple call to transfer funds to Dave from the 2-of-3 multisig
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob and Charlie (threshold: 2)
  const threshold = 2
  const otherSignatories = [bob.address, charlie.address].sort()
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot('events when Alice creates multisig for cancellation')

  // Check that Alice's multisig creation deposit was reserved
  const multisigBaseDeposit = client.api.consts.multisig.depositBase
  const multisigDepositFactor = client.api.consts.multisig.depositFactor
  let aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.reserved.toNumber(), 'Alice should have reserved funds for multisig deposit').toBe(
    multisigBaseDeposit.add(multisigDepositFactor.muln(threshold)).toNumber(),
  )

  // Get the multisig creation event to extract multisig account address and call hash
  let events = await client.api.query.system.events()

  const [multisigEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })

  assert(client.api.events.multisig.NewMultisig.is(multisigEvent.event))
  const multisigExtrinsicIndex = multisigEvent.phase.asApplyExtrinsic.toNumber()

  const newMultisigEventData = multisigEvent.event.data
  expect(newMultisigEventData.approving.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  const multisigAddress = newMultisigEventData.multisig
  const multisigCallHash = newMultisigEventData.callHash

  // Alice cancels the multisig operation
  const cancelTx = client.api.tx.multisig.cancelAsMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    multisigCallHash,
  )

  const cancelEvents = await sendTransaction(cancelTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that the multisig was cancelled successfully
  await checkEvents(cancelEvents, 'multisig').toMatchSnapshot('events when Alice cancels multisig')

  // Check that Alice's deposit was refunded
  aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.reserved.toNumber(), "Alice's deposit should have been refunded after cancellation").toBe(0)

  // Verify that Dave still has no funds (the transfer was cancelled)
  const daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have no funds after multisig cancellation').toBe(0)

  // Check the emitted cancellation event
  events = await client.api.query.system.events()
  const [multisigCancelledEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })
  assert(client.api.events.multisig.MultisigCancelled.is(multisigCancelledEvent.event))
  const multisigCancelledEventData = multisigCancelledEvent.event.data
  expect(multisigCancelledEventData.cancelling.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(multisigCancelledEventData.timepoint.height.toNumber()).toBe(currBlockNumber + 1)
  expect(multisigCancelledEventData.multisig.toString()).toBe(multisigAddress.toString())
  expect(multisigCancelledEventData.callHash.toString()).toBe(multisigCallHash.toString())
}

/**
 * Test multisig creation with too few signatories (0) fails with `TooFewSignatories`.
 *
 * 1. Alice attempts to create a multisig with 0 other signatories
 * 2. Verify that the transaction fails with `TooFewSignatories` error
 */
async function tooFewSignatoriesTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const dave = defaultAccountsSr25519.dave

  // Create a simple call to transfer funds to Dave
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice attempts to create a multisig with 0 other signatories (threshold: 1)
  const threshold = 2
  const otherSignatories: string[] = [] // Empty array - too few signatories
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 }

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  // Send the transaction - it will succeed but the extrinsic will fail
  await sendTransaction(asMultiTx.signAsync(alice))

  await client.dev.newBlock()

  // Check the event for the failed multisig creation
  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.multisig.TooFewSignatories.is(dispatchError.asModule))
}

/**
 * Test multisig creation with too many signatories fails with `TooManySignatories`.
 *
 * 1. Alice attempts to create a multisig with more signatories than allowed by `consts.multisig.maxSignatories`
 * 2. Verify that the transaction fails with `TooManySignatories` error
 */
async function tooManySignatoriesTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const dave = defaultAccountsSr25519.dave

  // Get the maximum allowed signatories from chain constants
  const maxSignatories = client.api.consts.multisig.maxSignatories.toNumber()

  // Create a simple call to transfer funds to Dave
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Create an array with too many signatories (maxSignatories + 1)
  // Use the keyring to generate valid addresses
  const { Keyring } = await import('@polkadot/keyring')
  const keyring = new Keyring({ type: 'sr25519' })

  const tooManySignatories = Array.from({ length: maxSignatories + 1 }, (_, i) => {
    const pair = keyring.addFromUri(`//test${i}`)
    return pair.address
  })

  // Alice attempts to create a multisig with too many signatories
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 }

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    tooManySignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  // Send the transaction - it will succeed but the extrinsic will fail
  await sendTransaction(asMultiTx.signAsync(alice))

  await client.dev.newBlock()

  // Check the event for the failed multisig creation
  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.multisig.TooManySignatories.is(dispatchError.asModule))
}

export function multisigE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, async () => {
    test('basic 2-of-3 multisig creation and execution', async () => {
      await basicMultisigTest(chain, testConfig.addressEncoding)
    })

    test('multisig cancellation', async () => {
      await multisigCancellationTest(chain, testConfig.addressEncoding)
    })

    test('multisig creation with too few signatories fails', async () => {
      await tooFewSignatoriesTest(chain, testConfig.addressEncoding)
    })

    test('multisig creation with too many signatories fails', async () => {
      await tooManySignatoriesTest(chain, testConfig.addressEncoding)
    })
  })
}
