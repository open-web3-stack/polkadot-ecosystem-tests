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

  await checkEvents(finalApprovalEvents, 'multisig')
    .redact({
      redactKeys: /height/,
    })
    .toMatchSnapshot('events when Alice approves multisig call')

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
  await checkEvents(cancelEvents, 'multisig')
    .redact({
      redactKeys: /height/,
    })
    .toMatchSnapshot('events when Alice cancels multisig')

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
>(chain: Chain<TCustom, TInitStorages>) {
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
>(chain: Chain<TCustom, TInitStorages>) {
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

  // Check for ExtrinsicFailed event
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

/**
 * Test multisig approval with remaining signatories out of order fails.
 *
 * 1. Alice creates a 2-of-3 multisig with Bob and Charlie (in correct order)
 * 2. Bob attempts to approve but passes the remaining signatories out of order
 * 3. Verify that the approval fails with an appropriate error
 */
async function signatoriesOutOfOrderTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
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

  // Create a simple call to transfer funds to Dave
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob and Charlie (threshold: 2) in correct order
  const threshold = 2
  const otherSignatories = [bob.address, charlie.address].sort() // Correct order
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 }

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))
  const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot('events when Alice creates multisig for ordering test')

  // Get the multisig creation event to extract multisig account address and call hash
  let events = await client.api.query.system.events()

  const [multisigEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })

  assert(client.api.events.multisig.NewMultisig.is(multisigEvent.event))
  const multisigExtrinsicIndex = multisigEvent.phase.asApplyExtrinsic.toNumber()

  // Bob attempts to approve but passes remaining signatories out of order
  const finalApprovalTx = client.api.tx.multisig.asMulti(
    threshold,
    [charlie.address, alice.address]
      .sort()
      .reverse(), // Out of alphabetical order
    {
      height: blockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    maxWeight,
  )

  await sendTransaction(finalApprovalTx.signAsync(bob))

  await client.dev.newBlock()

  // Check events for the failed multisig approval
  events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.multisig.SignatoriesOutOfOrder.is(dispatchError.asModule))
}

/**
 * Test multisig cancellation with remaining signatories out of order fails.
 *
 * 1. Alice creates a 2-of-3 multisig with Bob and Charlie (in correct order)
 * 2. Alice attempts to cancel but passes the remaining signatories out of order
 * 3. Verify that the cancellation fails with an appropriate error
 */
async function cancelWithSignatoriesOutOfOrderTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
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

  // Create a simple call to transfer funds to Dave
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob and Charlie (threshold: 2)
  const threshold = 2
  const otherSignatories = [bob.address, charlie.address].sort()
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 }

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))
  const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot(
    'events when Alice creates multisig for cancel ordering test',
  )

  // Get the multisig creation event to extract multisig account address and call hash
  let events = await client.api.query.system.events()

  const [multisigEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })

  assert(client.api.events.multisig.NewMultisig.is(multisigEvent.event))
  const multisigExtrinsicIndex = multisigEvent.phase.asApplyExtrinsic.toNumber()
  const multisigCallHash = multisigEvent.event.data.callHash

  // Alice attempts to cancel but passes remaining signatories out of order
  const cancelTx = client.api.tx.multisig.cancelAsMulti(
    threshold,
    [charlie.address, bob.address], // Out of order - should be [bob.address, charlie.address]
    {
      height: blockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    multisigCallHash,
  )

  // Send the transaction - it will succeed but the extrinsic will fail
  await sendTransaction(cancelTx.signAsync(alice))

  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(client.api.errors.multisig.SignatoriesOutOfOrder.is(dispatchError.asModule))
}

/**
 * Test that `approveAsMulti` does not lead to execution.
 *
 * 1. Alice creates a 2-of-3 multisig with Bob and Charlie
 * 2. Bob calls `approveAsMulti` (not `asMulti`) to provide final required approval for the operation
 * 3. Verify that the operation is not executed, only approved by Bob
 * 4. Charlie provides the final approval with `asMulti`
 * 5. Verify that the operation is executed
 */
async function approveAsMulti2Of3DoesNotExecuteTest<
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

  // Create a simple call to transfer funds to Dave
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob and Charlie (threshold: 2)
  const threshold = 2
  const otherSignatories = [bob.address, charlie.address].sort()
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 }

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))
  const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot(
    'events when Alice creates multisig for approveAsMulti test',
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
  const multisigAddress = newMultisigEventData.multisig
  const multisigCallHash = newMultisigEventData.callHash

  // Funds the multisig account to execute the call
  const multisigFunds = 101e10
  await client.dev.setStorage({
    System: {
      account: [[[multisigAddress], { providers: 1, data: { free: multisigFunds } }]],
    },
  })

  // Bob calls approveAsMulti (not asMulti) to approve the operation
  const approveTx = client.api.tx.multisig.approveAsMulti(
    threshold,
    [alice.address, charlie.address].sort(),
    {
      height: blockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    multisigCallHash,
    maxWeight,
  )

  let approveEvents = await sendTransaction(approveTx.signAsync(bob))

  await client.dev.newBlock()

  // Check that the approval was successful but execution did not occur
  await checkEvents(approveEvents, 'multisig')
    .redact({
      redactKeys: /height/,
    })
    .toMatchSnapshot('events when Bob approves with approveAsMulti')

  // Verify that Dave still has no funds (the transfer was not executed)
  let daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have no funds after approveAsMulti').toBe(0)

  // Verify that the multisig account still has its funds (no execution occurred)
  const multisigAccount = await client.api.query.system.account(multisigAddress)
  expect(multisigAccount.data.free.toNumber(), 'Multisig account should still have its funds').toBe(multisigFunds)

  // Check for `MultisigApproval` event (not `MultisigExecuted`)
  events = await client.api.query.system.events()
  const [multisigApprovalEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig' && event.method === 'MultisigApproval'
  })

  assert(client.api.events.multisig.MultisigApproval.is(multisigApprovalEvent.event))
  const multisigApprovalEventData = multisigApprovalEvent.event.data
  expect(multisigApprovalEventData.approving.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(multisigApprovalEventData.timepoint.height.toNumber()).toBe(blockNumber + 1)
  expect(multisigApprovalEventData.multisig.toString()).toBe(multisigAddress.toString())
  expect(multisigApprovalEventData.callHash.toString()).toBe(multisigCallHash.toString())

  // Cabally verify that no `MultisigExecuted` event was emitted
  const executedEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig' && event.method === 'MultisigExecuted'
  })
  expect(executedEvents.length).toBe(0)

  // Have Charlie provide the final approval with `approveAsMulti`
  await client.dev.setStorage({
    System: {
      account: [[[charlie.address], { providers: 1, data: { free: 1000e10 } }]],
    },
  })

  const approveTx2 = client.api.tx.multisig.asMulti(
    threshold,
    [bob.address, alice.address].sort(),
    {
      height: blockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    maxWeight,
  )

  approveEvents = await sendTransaction(approveTx2.signAsync(charlie))

  await client.dev.newBlock()

  // Check that the multisig was executed successfully
  await checkEvents(approveEvents, 'multisig')
    .redact({
      redactKeys: /height/,
    })
    .toMatchSnapshot('events when Charlie provides final approval')

  // Check that the transfer was executed
  daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have received funds').toBe(transferAmount)
}

/**
 * Test that the final approver using `approveAsMulti` results in an `AlreadyApproved` error.
 *
 * 1. Alice creates a 2-of-2 multisig with Bob using `asMulti`
 * 2. Bob calls `approveAsMulti` to approve the operation
 * 3. Verify that the multisig operation has not executed
 * 4. Alice calls `asMulti` again to execute the operation
 * 5. Verify that the transfer was executed
 */
async function finalApprovalApproveAsMultiTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const dave = defaultAccountsSr25519.dave

  // Fund test accounts
  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: 1000e10 } }]],
    },
  })

  // Create a simple call to transfer funds to Dave
  const transferAmount = 10e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob (threshold: 2)
  const threshold = 2
  const otherSignatories = [bob.address]
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 }

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  await sendTransaction(asMultiTx.signAsync(alice))
  const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Get the multisig creation event to extract multisig account address and call hash
  let events = await client.api.query.system.events()

  const [multisigEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })

  assert(client.api.events.multisig.NewMultisig.is(multisigEvent.event))
  const multisigExtrinsicIndex = multisigEvent.phase.asApplyExtrinsic.toNumber()
  const multisigAddress = multisigEvent.event.data.multisig
  const newMultisigEventData = multisigEvent.event.data
  const multisigCallHash = newMultisigEventData.callHash

  // Fund the multisig account to execute the call
  const multisigFunds = transferAmount * 10
  await client.dev.setStorage({
    System: {
      account: [[[multisigAddress], { providers: 1, data: { free: multisigFunds } }]],
    },
  })

  // Bob calls approveAsMulti to approve the operation (but not execute it), thereby passing final approval
  // back to Alice.
  const approveTx = client.api.tx.multisig.approveAsMulti(
    threshold,
    [alice.address],
    {
      height: blockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    multisigCallHash,
    maxWeight,
  )

  // This'll hold a `MultisigApproved` but not `MultisigExecuted`
  const approveEvents = await sendTransaction(approveTx.signAsync(bob))

  // Check Dave's account balance
  let daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), "Dave still has no funds after Bob's final approval").toBe(0)

  await client.dev.newBlock()

  await checkEvents(approveEvents, 'multisig').toMatchSnapshot(
    'events when Bob makes final approval with approveAsMulti',
  )

  events = await client.api.query.system.events()
  expect(
    events.filter((record) => {
      const { event } = record
      return event.section === 'multisig' && event.method === 'MultisigApproval'
    }).length,
  ).toBe(1)
  expect(
    events.filter((record) => {
      const { event } = record
      return event.section === 'multisig' && event.method === 'MultisigExecuted'
    }).length,
  ).toBe(0)

  // Alice calls `asMulti` to execute the operation

  const executeTx = client.api.tx.multisig.asMulti(
    threshold,
    [bob.address],
    {
      height: blockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    maxWeight,
  )

  await sendTransaction(executeTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that the transfer was executed
  daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have received funds').toBe(transferAmount)
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
      await tooFewSignatoriesTest(chain)
    })

    test('multisig creation with too many signatories fails', async () => {
      await tooManySignatoriesTest(chain)
    })

    test('multisig approval with remaining signatories out of order fails', async () => {
      await signatoriesOutOfOrderTest(chain)
    })

    test('multisig cancellation with remaining signatories out of order fails', async () => {
      await cancelWithSignatoriesOutOfOrderTest(chain)
    })

    test('second approval (with `approveAsMulti`) in 2-of-3 multisig is successful and does not lead to execution', async () => {
      await approveAsMulti2Of3DoesNotExecuteTest(chain, testConfig.addressEncoding)
    })

    test('final approval with `approveAsMulti` does not lead to execution', async () => {
      await finalApprovalApproveAsMultiTest(chain)
    })
  })
}
