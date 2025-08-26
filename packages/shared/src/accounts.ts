import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkEvents } from './helpers/index.js'

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
 * 5. Check that events emitted in the course of operation contain correct data
 */
async function transferAllowDeathTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const transferAmount = existentialDeposit + existentialDeposit / 10n
  // When transferring the amount above, net of fees, the account will have less than 1 ED.
  const alice = await createAccountWithBalance(client, transferAmount, '//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have empty data before transfer
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, 2n * transferAmount)

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
  ).toMatchSnapshot('events when Alice `transfer_allow_death` to Bob')

  // Verify account was reaped
  expect(await isAccountReaped(client, alice.address)).toBe(true)

  const bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toBigInt()).toBe(existentialDeposit)

  // Check 4 events snapshot above

  // Check `Transfer` event
  const events = await client.api.query.system.events()
  const transferEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Transfer'
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
  expect(withdrawEventData.amount.toBigInt()).toBeLessThan(existentialDeposit / 10n)

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
  expect(dustLostEventData.amount.toBigInt()).toBeLessThan(existentialDeposit / 10n)

  // The fee paid by Alice and the dust lost, along with the amount transferred to Bob,
  // should sum to Alice's initial balance.
  expect(existentialDeposit + withdrawEventData.amount.toBigInt() + dustLostEventData.amount.toBigInt()).toBe(
    existentialDeposit + existentialDeposit / 10n,
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
}

/**
 * Test `force_transfer` with bad origin (non-root)
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

export const transferFunctionsTests = (
  chain: Chain,
  testConfig: { testSuiteName: string; addressEncoding: number },
): RootTestTree => ({
  kind: 'describe',
  label: testConfig.testSuiteName,
  children: [
    {
      kind: 'describe',
      label: '`transfer_allow_death`',
      children: [
        {
          kind: 'test',
          label: 'should allow killing sender account',
          testFn: () => transferAllowDeathTest(chain, testConfig.addressEncoding),
        },
      ],
    },
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
          kind: 'test',
          label: '`BadOrigin` error from non-root',
          testFn: () => forceTransferBadOriginTest(chain),
        },
      ],
    },
  ],
})
