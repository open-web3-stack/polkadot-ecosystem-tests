import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { match } from 'ts-pattern'
import {
  type LowEdChain as ChainEd,
  checkEvents,
  checkSystemEvents,
  createXcmTransactSend,
  scheduleInlineCallWithOrigin,
} from './helpers/index.js'

/// -------
/// Helpers
/// -------

/**
 * Create a fresh account with specific balance above existential deposit
 */
async function createAccountWithBalance<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, balance: any, seed: string): Promise<KeyringPair> {
  // Create fresh account from seed
  const newAccount = defaultAccountsSr25519.keyring.createFromUri(`${seed}`)

  // Set account balance directly via storage
  await client.dev.setStorage({
    System: {
      account: [[[newAccount.address], { providers: 1, data: { free: balance } }]],
    },
  })

  return newAccount
}

/**
 * Given a client, query if an account has been reaped (removed from storage).
 *
 * @returns a promise that resolves to true if the account has been reaped, false otherwise.
 */
async function isAccountReaped(client: Client<any, any>, address: string): Promise<boolean> {
  const account = await client.api.query.system.account(address)
  // An account is reaped (or never existed) if it has no nonce, no providers, and zero balance.
  return (
    account.consumers.toNumber() === 0 &&
    account.providers.toNumber() === 0 &&
    account.sufficients.toNumber() === 0 &&
    account.data.free.toBigInt() === 0n &&
    account.data.frozen.toBigInt() === 0n &&
    account.data.reserved.toBigInt() === 0n
  )
}

/// -----
/// Tests
/// -----

/**
 * Test that `transfer_allow_death` allows the killing of the sender account.
 *
 * 1. Create a fresh account with balance above existential deposit
 * 2. Create a fresh account with balance equal to existential deposit
 * 3. Transfer all balance away from the first account to the second account
 * 4. Verify that the first account has been reaped
 * 5. Check that events emitted as a result of this operation contain correct data
 */
async function transferAllowDeathTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const eps = existentialDeposit / 3n
  // When transferring this amount, net of fees, the account should have less than 1 ED remaining.
  const totalBalance = existentialDeposit + eps
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have empty data before transfer
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, existentialDeposit)

  const transferEvents = await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // `Deposit` events are irrelevant, as they contain data that may change as `chopsticks` selects different block
  // producers each test run, causing the snapshot to fail.
  await checkEvents(
    transferEvents,
    // Event of transfer from Alice to Bob
    { section: 'balances', method: 'Transfer' },
    // Event of fee withdrawal from Alice
    { section: 'balances', method: 'Withdraw' },
    // Alice account is reaped, so dust is lost
    { section: 'balances', method: 'DustLost' },
    // Bob's account was fundless, and its endowment emits an event
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'KilledAccount' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events when Alice `transfer_allow_death` to Bob')

  // Verify only Alice's account was reaped
  expect(await isAccountReaped(client, alice.address)).toBe(true)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  const bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toBigInt()).toBe(existentialDeposit)

  // Check the events snapshot above:
  // 1. `Transfer` event
  // 2. `Withdraw` event
  // 3. `DustLost` event
  // 4. `Endowed` event
  // 5. `KilledAccount` event
  // 6. `NewAccount` event

  // Check `Transfer` event
  const events = await client.api.query.system.events()
  const transferEvent = events.find((record) => {
    const { event } = record
    if (event.section === 'balances' && event.method === 'Transfer') {
      assert(client.api.events.balances.Transfer.is(event))
      if (event.data.from.toString() === encodeAddress(alice.address, addressEncoding)) {
        return true
      }
    }
  })
  expect(transferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(existentialDeposit)

  // Check `Withdraw` event
  const withdrawEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Withdraw'
  })
  expect(withdrawEvent).toBeDefined()
  assert(client.api.events.balances.Withdraw.is(withdrawEvent!.event))
  const withdrawEventData = withdrawEvent!.event.data
  expect(withdrawEventData.who.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  // The actual fee amount is nondeterministic, and by itself also irrelevant to the test.
  // Just checking it's bound in a reasonable interval is enough.
  expect(withdrawEventData.amount.toBigInt()).toBeGreaterThan(0n)
  expect(withdrawEventData.amount.toBigInt()).toBeLessThan(eps)

  // Check `DustLost` event
  const dustLostEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'DustLost'
  })
  expect(dustLostEvent).toBeDefined()
  assert(client.api.events.balances.DustLost.is(dustLostEvent!.event))
  const dustLostEventData = dustLostEvent!.event.data
  expect(dustLostEventData.account.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(dustLostEventData.amount.toBigInt()).toBeGreaterThan(0n)
  expect(dustLostEventData.amount.toBigInt()).toBeLessThan(eps)

  // The fee paid by Alice and the dust lost, along with the amount transferred to Bob,
  // should sum to Alice's initial balance.
  expect(existentialDeposit + withdrawEventData.amount.toBigInt() + dustLostEventData.amount.toBigInt()).toBe(
    totalBalance,
  )

  // Check `Endowed` event
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeDefined()
  assert(client.api.events.balances.Endowed.is(endowedEvent!.event))
  const endowedEventData = endowedEvent!.event.data
  expect(endowedEventData.account.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(endowedEventData.freeBalance.toBigInt()).toBe(existentialDeposit)

  // Check `KilledAccount` event
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeDefined()
  assert(client.api.events.system.KilledAccount.is(killedAccountEvent!.event))
  const killedAccountEventData = killedAccountEvent!.event.data
  expect(killedAccountEventData.account.toString()).toBe(encodeAddress(alice.address, addressEncoding))

  // Check `NewAccount` event
  const newAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'NewAccount'
  })
  expect(newAccountEvent).toBeDefined()
  assert(client.api.events.system.NewAccount.is(newAccountEvent!.event))
  const newAccountEventData = newAccountEvent!.event.data
  expect(newAccountEventData.account.toString()).toBe(encodeAddress(bob.address, addressEncoding))
}

/**
 * Test that `transfer_allow_death` with sufficient balance preserves the sender account.
 *
 * 1. Create a fresh account with high balance
 * 2. Transfer a small amount to another account
 * 3. Verify that the sender account is not reaped
 * 4. Check events and post-transfer account data
 */
async function transferAllowDeathNoKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const totalBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  // Verify initial state
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const transferAmount = existentialDeposit // 1 ED
  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  const transferEvents = await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Snapshot some events
  await checkEvents(
    transferEvents,
    // Event of transfer from Alice to Bob
    { section: 'balances', method: 'Transfer' },
    // Event of fee withdrawal from Alice
    { section: 'balances', method: 'Withdraw' },
    // Bob's account was fundless, and its endowment emits an event
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events when Alice transfers 1 ED to Bob with sufficient balance')

  // Verify Alice's account was NOT reaped
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  // Check final balances
  const aliceAccount = await client.api.query.system.account(alice.address)
  const bobAccount = await client.api.query.system.account(bob.address)

  // Get the extrinsic's fee
  const events = await client.api.query.system.events()
  const txPaymentEvent = events.find((record) => {
    const { event } = record
    return event.section === 'transactionPayment' && event.method === 'TransactionFeePaid'
  })
  assert(client.api.events.transactionPayment.TransactionFeePaid.is(txPaymentEvent!.event))
  const txPaymentEventData = txPaymentEvent!.event.data
  assert(txPaymentEventData.tip.toBigInt() === 0n, 'unexpected extrinsic tip')
  expect(txPaymentEventData.actualFee.toBigInt()).toBeGreaterThan(0n)

  expect(bobAccount.data.free.toBigInt()).toBe(transferAmount)
  // Alice should have her original balance minus the transfer amount minus fees
  expect(aliceAccount.data.free.toBigInt()).toBe(
    totalBalance - transferAmount - txPaymentEventData.actualFee.toBigInt(),
  )

  // Check events - verify NO KilledAccount events are present
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeUndefined()

  // Verify transfer event
  const transferEvent = events.find((record) => {
    const { event } = record
    if (event.section === 'balances' && event.method === 'Transfer') {
      assert(client.api.events.balances.Transfer.is(event))
      if (event.data.from.toString() === encodeAddress(alice.address, addressEncoding)) {
        return true
      }
    }
  })
  expect(transferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(transferAmount)

  // Verify withdraw event
  const withdrawEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Withdraw'
  })
  expect(withdrawEvent).toBeDefined()
  assert(client.api.events.balances.Withdraw.is(withdrawEvent!.event))
  const withdrawEventData = withdrawEvent!.event.data
  expect(withdrawEventData.who.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(withdrawEventData.amount.toBigInt()).toBe(txPaymentEventData.actualFee.toBigInt())

  // Verify endowment event
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeDefined()
  assert(client.api.events.balances.Endowed.is(endowedEvent!.event))
  const endowedEventData = endowedEvent!.event.data
  expect(endowedEventData.account.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(endowedEventData.freeBalance.toBigInt()).toBe(transferAmount)

  // Verify `NewAccount` event
  const newAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'NewAccount'
  })
  expect(newAccountEvent).toBeDefined()
}

/**
 * Test that `force_transfer` allows the killing of the source account.
 *
 * 1. Create a fresh account with balance above existential deposit
 * 2. Force transfer all balance away from the first account to the second account
 * 3. Verify that the first account has been reaped
 * 4. Check that events emitted as a result of this operation contain correct data
 *
 * NOTE: As is usual for PET tests, to simulate execution by a non-signed origin, the scheduler pallet's agenda is
 * manually modified to include a `balances.force_transfer` call for execution in the next block.
 *
 * If the runtime of the chain running this test does have the scheduler pallet, this test must also be given
 * the chain object of its relay chain, so that XCM can be used to execute a `xcmPallet.send` call with a
 * `Transact` containing `balances.force_transfer`, for execution in the chain being tested.
 */
async function forceTransferKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  addressEncoding: number,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available - if not, a relay client needs to be created for an XCM interaction,
  // and the base client needs to be recreated simultaneously - otherwise, they would be unable tocommunicate.
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // Create fresh account
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const eps = existentialDeposit / 3n
  const totalBalance = existentialDeposit + eps
  const alice = await createAccountWithBalance(baseClient, totalBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have expected initial state
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, bob.address, existentialDeposit)

  if (hasScheduler) {
    // Use root origin to execute force transfer directly
    await scheduleInlineCallWithOrigin(baseClient, forceTransferTx.method.toHex(), { system: 'Root' })
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' })

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // Verify only Alice's account was reaped
  expect(await isAccountReaped(baseClient, alice.address)).toBe(true)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(false)

  const bobAccount = await baseClient.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toBigInt()).toBe(existentialDeposit)

  // Snapshot events
  await checkSystemEvents(
    baseClient,
    { section: 'balances', method: 'Transfer' },
    { section: 'balances', method: 'DustLost' },
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'KilledAccount' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events of `force_transfer` from Alice to Bob')

  // Check events:
  // 1. `Transfer` event
  // 2. `DustLost` event
  // 3. `Endowed` event
  // 4. `KilledAccount` event
  // 5. `NewAccount` event
  const events = await baseClient.api.query.system.events()

  // Check `Transfer` event
  const transferEvent = events.find((record) => {
    const { event } = record
    if (event.section === 'balances' && event.method === 'Transfer') {
      assert(baseClient.api.events.balances.Transfer.is(event))
      if (event.data.from.toString() === encodeAddress(alice.address, addressEncoding)) {
        return true
      }
    }
  })
  expect(transferEvent).toBeDefined()
  assert(baseClient.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(existentialDeposit)

  // Check `DustLost` event
  const dustLostEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'DustLost'
  })
  expect(dustLostEvent).toBeDefined()
  assert(baseClient.api.events.balances.DustLost.is(dustLostEvent!.event))
  const dustLostEventData = dustLostEvent!.event.data
  expect(dustLostEventData.account.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(dustLostEventData.amount.toBigInt()).toBe(eps)

  // Check `Endowed` event
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeDefined()
  assert(baseClient.api.events.balances.Endowed.is(endowedEvent!.event))
  const endowedEventData = endowedEvent!.event.data
  expect(endowedEventData.account.toString()).toBe(encodeAddress(bob.address, addressEncoding))
  expect(endowedEventData.freeBalance.toBigInt()).toBe(existentialDeposit)

  // Check `KilledAccount` event
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeDefined()
  assert(baseClient.api.events.system.KilledAccount.is(killedAccountEvent!.event))
  const killedAccountEventData = killedAccountEvent!.event.data
  expect(killedAccountEventData.account.toString()).toBe(encodeAddress(alice.address, addressEncoding))

  // Check `NewAccount` event
  const newAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'NewAccount'
  })
  expect(newAccountEvent).toBeDefined()
  assert(baseClient.api.events.system.NewAccount.is(newAccountEvent!.event))
  const newAccountEventData = newAccountEvent!.event.data
  expect(newAccountEventData.account.toString()).toBe(encodeAddress(bob.address, addressEncoding))
}

/**
 * Test that `transfer_allow_death` fails when transferring below existential deposit.
 *
 * 1. Create a fresh account with high balance
 * 2. Attempt to transfer an amount below ED to another account
 * 3. Verify that the transaction fails
 * 4. Check that no funds were transferred, only fees deducted
 */
async function transferBelowExistentialDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  // Verify initial state
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const transferAmount = existentialDeposit - 1n
  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that transaction failed with ExistentialDeposit error
  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError

  // Check that it's the ExistentialDeposit error from balances pallet
  assert(dispatchError.isToken)
  const tokenError = dispatchError.asToken
  assert(tokenError.isBelowMinimum)

  // Verify no transfer occurred - Alice still has original balance, Bob still reaped
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Get the transaction fee from the payment event
  const txPaymentEvent = events.find((record) => {
    const { event } = record
    return event.section === 'transactionPayment' && event.method === 'TransactionFeePaid'
  })
  assert(client.api.events.transactionPayment.TransactionFeePaid.is(txPaymentEvent!.event))
  const txPaymentEventData = txPaymentEvent!.event.data
  assert(txPaymentEventData.tip.toBigInt() === 0n, 'unexpected extrinsic tip')
  expect(txPaymentEventData.actualFee.toBigInt()).toBeGreaterThan(0n)

  // Verify Alice's balance only decreased by the transaction fee
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - txPaymentEventData.actualFee.toBigInt())
}

/**
 * Test that `transfer_allow_death` fails when sender has insufficient funds.
 *
 * 1. Create a fresh account with some balance
 * 2. Attempt to transfer more than the account has to another account
 * 3. Verify that the transaction fails
 * 4. Check that no transfer occurred and only fees were deducted
 */
async function transferInsufficientFundsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, _addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const totalBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Try to transfer more than Alice has (200 ED when she only has 100 ED)
  const transferAmount = 2n * totalBalance
  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that transaction failed with FundsUnavailable error
  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError

  // Check that it's the FundsUnavailable token error
  assert(dispatchError.isToken)
  const tokenError = dispatchError.asToken
  assert(tokenError.isFundsUnavailable)

  // Verify no transfer occurred - Alice still has funds, Bob still unalive
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Get the transaction fee from the payment event
  const txPaymentEvent = events.find((record) => {
    const { event } = record
    return event.section === 'transactionPayment' && event.method === 'TransactionFeePaid'
  })
  assert(client.api.events.transactionPayment.TransactionFeePaid.is(txPaymentEvent!.event))
  const txPaymentEventData = txPaymentEvent!.event.data
  assert(txPaymentEventData.tip.toBigInt() === 0n, 'unexpected extrinsic tip')
  expect(txPaymentEventData.actualFee.toBigInt()).toBeGreaterThan(0n)

  // Verify Alice's balance only decreased by the transaction fee
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(totalBalance - txPaymentEventData.actualFee.toBigInt())
}

/**
 * Test that `force_transfer` fails when transferring below existential deposit.
 *
 * 1. Create a fresh account with high balance
 * 2. Attempt to force transfer an amount below ED to another account using root origin
 * 3. Verify that the transaction fails
 * 4. Check that no transfer occurred (no fees, either)
 */
async function forceTransferBelowExistentialDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  _addressEncoding: number,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // Create fresh accounts
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(baseClient, aliceBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  // Verify initial state
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  const transferAmount = existentialDeposit - 1n
  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, bob.address, transferAmount)

  if (hasScheduler) {
    // Use root origin to execute force transfer directly
    await scheduleInlineCallWithOrigin(baseClient, forceTransferTx.method.toHex(), { system: 'Root' })
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' })

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // Check that transaction failed with BelowMinimum error
  const events = await baseClient.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  // No events are emitted from this failure, as it was the result of a
  expect(failedEvent).toBeUndefined()

  if (hasScheduler) {
    const dispatchedEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'Dispatched'
    })
    expect(dispatchedEvent).toBeDefined()
    assert(baseClient.api.events.scheduler.Dispatched.is(dispatchedEvent!.event))
    const dispatchData = dispatchedEvent!.event.data
    assert(dispatchData.result.isErr)
    const dispatchError = dispatchData.result.asErr

    assert(dispatchError.isToken)
    const tokenError = dispatchError.asToken
    assert(tokenError.isBelowMinimum)
  }

  // Verify no transfer occurred - Alice still has original balance, Bob still in oblivion
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // Alice's balance should be unchanged (no fees for failed force transfers)
  const aliceAccount = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance)
}

/**
 * Test force transfer when source has insufficient funds.
 *
 * 1. Create Alice with some balance
 * 2. Try to force transfer more than Alice has to Bob
 * 3. Verify the transaction fails
 * 4. Check that Alice's balance is unchanged (no fees for force transfers)
 */
async function forceTransferInsufficientFundsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  _addressEncoding: number,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // Create fresh accounts
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit
  const alice = await createAccountWithBalance(baseClient, aliceBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // Try to force transfer more than Alice has (2 ED when she only has 1)
  const transferAmount = 2n * aliceBalance
  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, bob.address, transferAmount)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(baseClient, forceTransferTx.method.toHex(), { system: 'Root' })
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' })

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // Check for failure
  const events = await baseClient.api.query.system.events()

  if (hasScheduler) {
    const dispatchedEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'Dispatched'
    })
    expect(dispatchedEvent).toBeDefined()
    assert(baseClient.api.events.scheduler.Dispatched.is(dispatchedEvent!.event))
    const dispatchData = dispatchedEvent!.event.data
    assert(dispatchData.result.isErr)
    const dispatchError = dispatchData.result.asErr

    assert(dispatchError.isToken)
    const tokenError = dispatchError.asToken
    assert(tokenError.isFundsUnavailable)
  }

  // Verify no transfer occurred
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // Alice's balance should be unchanged (no fees for failed force transfers)
  const aliceAccount = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance)
}

/**
 * Test `force_transfer` with a bad origin (non-root).
 */
async function forceTransferBadOriginTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const transferAmount = existentialDeposit
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  const forceTransferTx = client.api.tx.balances.forceTransfer(alice.address, bob.address, transferAmount)
  await sendTransaction(forceTransferTx.signAsync(alice)) // Regular user, not root
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isBadOrigin) // BadOrigin is a top-level DispatchError, not a module error
}

/// -------
/// Test Tree
/// -------

/**
 * Tests to `transfer_allow_death` that can run on any chain, regardless of the magnitude of its ED.
 */
const commonTransferAllowDeathTests = (
  chain: Chain,
  testConfig: { testSuiteName: string; addressEncoding: number },
) => [
  {
    kind: 'test' as const,
    label: 'transfer of some funds does not kill sender account',
    testFn: () => transferAllowDeathNoKillTest(chain, testConfig.addressEncoding),
  },
  {
    kind: 'test' as const,
    label: 'transfer below existential deposit fails',
    testFn: () => transferBelowExistentialDepositTest(chain, testConfig.addressEncoding),
  },
  {
    kind: 'test' as const,
    label: 'transfer with insufficient funds fails',
    testFn: () => transferInsufficientFundsTest(chain, testConfig.addressEncoding),
  },
]

/**
 * Tests to `transfer_allow_death` that may require the chain's ED to be at least as large as the usual transaction
 * fee.
 */
const fullTransferAllowDeathTests = (
  chain: Chain,
  testConfig: { testSuiteName: string; addressEncoding: number },
): RootTestTree => ({
  kind: 'describe',
  label: 'transfer_allow_death',
  children: [
    {
      kind: 'test',
      label: 'leaving an account below ED kills it',
      testFn: () => transferAllowDeathTest(chain, testConfig.addressEncoding),
    },
    ...commonTransferAllowDeathTests(chain, testConfig),
  ],
})

/**
 * Tests to be run on chains with a relatively small ED (compared to the typical transaction fee).
 */
const partialTransferAllowDeathTests = (
  chain: Chain,
  testConfig: { testSuiteName: string; addressEncoding: number },
): RootTestTree => ({
  kind: 'describe',
  label: 'transfer_allow_death',
  children: commonTransferAllowDeathTests(chain, testConfig),
})

export const transferFunctionsTests = (
  chain: Chain,
  testConfig: { testSuiteName: string; addressEncoding: number; chainEd: ChainEd },
  relayChain?: Chain,
): RootTestTree => ({
  kind: 'describe',
  label: testConfig.testSuiteName,
  children: [
    match(testConfig.chainEd)
      .with('LowEd', () => partialTransferAllowDeathTests(chain, testConfig))
      .with('Normal', () => fullTransferAllowDeathTests(chain, testConfig))
      .exhaustive(),
    {
      kind: 'describe',
      label: '`transfer_keep_alive`',
      children: [],
    },
    {
      kind: 'describe',
      label: '`transfer_all`',
      children: [],
    },
    {
      kind: 'describe',
      label: '`force_transfer`',
      children: [
        {
          kind: 'test' as const,
          label: 'force transfer below ED can kill source account',
          testFn: () => forceTransferKillTest(chain, testConfig.addressEncoding, relayChain),
        },
        {
          kind: 'test' as const,
          label: 'force transfer below existential deposit fails',
          testFn: () => forceTransferBelowExistentialDepositTest(chain, testConfig.addressEncoding, relayChain),
        },
        {
          kind: 'test' as const,
          label: 'force transfer with insufficient funds fails',
          testFn: () => forceTransferInsufficientFundsTest(chain, testConfig.addressEncoding, relayChain),
        },
        {
          kind: 'test',
          label: 'non-root origins cannot force transfer',
          testFn: () => forceTransferBadOriginTest(chain),
        },
      ],
    },
  ],
})
