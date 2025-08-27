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
  const alice = await createAccountWithBalance(client, totalBalance, '//simple_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//simple_bob')

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

  //console.log(transferAmount + txPaymentEventData.actualFee.toBigInt())
  //await client.pause()

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
 */
async function forceTransferKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  // Create fresh account
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const eps = existentialDeposit / 3n
  const totalBalance = existentialDeposit + eps
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have expected initial state
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const forceTransferTx = client.api.tx.balances.forceTransfer(alice.address, bob.address, existentialDeposit)

  // Use root origin to execute force transfer
  await scheduleInlineCallWithOrigin(client, forceTransferTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  // Verify only Alice's account was reaped
  expect(await isAccountReaped(client, alice.address)).toBe(true)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  const bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toBigInt()).toBe(existentialDeposit)

  // Snapshot events
  await checkSystemEvents(
    client,
    { section: 'balances', method: 'Transfer' },
    { section: 'balances', method: 'Withdraw' },
    { section: 'balances', method: 'DustLost' },
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'KilledAccount' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events of `force_transfer` from Alice to Bob')

  // Check events:
  // 1. `Transfer` event
  // 2. `Withdraw` event
  // 3. `DustLost` event
  // 4. `Endowed` event
  // 5. `KilledAccount` event
  // 6. `NewAccount` event
  const events = await client.api.query.system.events()

  // Check `Transfer` event
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
  expect(withdrawEventData.amount.toBigInt()).toBe(existentialDeposit)

  // Check `DustLost` event
  const dustLostEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'DustLost'
  })
  expect(dustLostEvent).toBeDefined()
  assert(client.api.events.balances.DustLost.is(dustLostEvent!.event))
  const dustLostEventData = dustLostEvent!.event.data
  expect(dustLostEventData.account.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  expect(dustLostEventData.amount.toBigInt()).toBe(eps)

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
          testFn: () => forceTransferKillTest(chain, testConfig.addressEncoding),
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
